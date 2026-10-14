/* Native boundary harness for tests/adapter-semantics.ts.
 *
 * The including translation unit first includes the generated types and
 * canonical codecs of one fixture, defines the ASEM_* parameters below, then
 * includes this file, redirects the adapter's boundary calls to the asem_*
 * functions with macros, and finally includes the emitted ABI 1 adapter text
 * byte-for-byte. The effect validate/execute redirects are function-like and
 * also pass the adapter's effect array, so slots are labelled from its base.
 *
 * What is real: the emitted entrypoint, runtime/solana_min.h (loader parsing,
 * read_le, equal_key), the emitted effect extraction, and the generated codecs
 * and Bend root that the wrappers delegate to.
 * What is mocked: the Clock and return-data syscalls, custody derivation, and
 * effect validation/execution. Their results are scripted per scenario. The
 * codec and root wrappers can additionally force a failure or an outcome.
 * A mocked execution never touches the state account and nothing here rolls
 * an "executed" effect back: rollback of external effects is Solana's.
 *
 * Required parameters:
 *   ASEM_STATE_T ASEM_IX_T ASEM_CTX_T ASEM_OUT_T      generated C types
 *   ASEM_STATE_DECODE ASEM_IX_DECODE ASEM_STATE_ENCODE ASEM_ROOT   real names
 *   ASEM_HEADER_BYTES ASEM_PAYLOAD_BYTES              state account layout
 *   ASEM_EFFECTS                                      0 none, 1 token, 2 CPI
 *   ASEM_SET_REJECT(o,code) ASEM_BAD_TAG ASEM_SPOIL_EFFECTS(o)
 *   ASEM_SWAP_EFFECTS(o)                              exchange effect slots 0 and 1
 */
#pragma once
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "solana_min.h"
#if ASEM_EFFECTS == 1
#include "token.h"
typedef BendTransfer AsemEffect;
#elif ASEM_EFFECTS == 2
#include <bend_cpi.h>
typedef BendInvoke AsemEffect;
#endif

#define ASEM_SLOTS 8
#define ASEM_BYTES 4096
#define ASEM_BUMP 0xA7u
#define ASEM_SLOT 0x1122334455667788ULL
#define ASEM_TOTAL (ASEM_HEADER_BYTES + ASEM_PAYLOAD_BYTES)

typedef struct {
  long id;
  unsigned count;              /* serialized account count */
  int dup_marker;              /* account index carrying a loader alias marker, or -1 */
  int dup_a, dup_b;            /* account dup_b reuses the key of dup_a, or -1 */
  unsigned owner_fault;        /* 1 + index of the owner byte that differs, or 0 */
  unsigned executable, writable, state_signer, actor_signer;
  u64 state_size;
  u64 custody;                 /* custody setup result */
  unsigned state_decode_fail, ix_decode_fail, clock_fail;
  unsigned root_mode;          /* 0 real, 1 Rejected{root_code}, 2 unknown tag, 3 unextractable effects,
                                  4 real with effect slots 0 and 1 exchanged */
  u32 root_code;
  unsigned encode_fail;
  u64 validate[ASEM_SLOTS], execute[ASEM_SLOTS];
  size_t data_len, ix_len;
  u8 data[ASEM_BYTES], ix[ASEM_BYTES];
} AsemScenario;

static AsemScenario asem;
static char asem_trace[2048];
static size_t asem_trace_len;
static const u8 *asem_state_data, *asem_ix, *asem_actor_key, *asem_state_key;
static u8 asem_program[32];
static unsigned asem_executed;
static u8 asem_return[ASEM_BYTES];
static u64 asem_return_len;
static unsigned asem_return_calls;

static void asem_fail(const char *message) {
  fprintf(stderr, "adapter-semantics harness: %s (scenario %ld)\n", message, asem.id);
  exit(3);
}
__attribute__((format(printf, 1, 2)))
static void asem_event(const char *format, ...) {
  va_list args;
  if (asem_trace_len) asem_trace[asem_trace_len++] = ',';
  va_start(args, format);
  int n = vsnprintf(asem_trace + asem_trace_len, sizeof(asem_trace) - asem_trace_len, format, args);
  va_end(args);
  if (n < 0 || (size_t)n >= sizeof(asem_trace) - asem_trace_len - 1) asem_fail("trace overflow");
  asem_trace_len += (size_t)n;
}

/* ---- Syscall boundary ---------------------------------------------------- */
void sol_set_return_data(const u8 *bytes, u64 length) {
  asem_event("R%llu", length);
  if (length > sizeof(asem_return)) asem_fail("return data too long");
  memcpy(asem_return, bytes, (size_t)length);
  asem_return_len = length;
  ++asem_return_calls;
}
u64 sol_get_clock_sysvar(void *out) {
  struct { u64 slot; long long start; u64 epoch, leader; long long unix_timestamp; } clock = {ASEM_SLOT, 1, 2, 3, 4};
  asem_event("k");
  memcpy(out, &clock, sizeof(clock));
  return asem.clock_fail;
}
#if ASEM_EFFECTS
/* The real helpers that would reach these are replaced by the mocks below. */
u64 sol_try_find_program_address(const BendSeed *seeds, int count, const u8 *program, u8 *key, u8 *bump) {
  (void)seeds; (void)count; (void)program; (void)key; (void)bump;
  asem_fail("unexpected sol_try_find_program_address");
  return 1;
}
u64 sol_invoke_signed_c(const BendInstruction *ix, const BendAccountInfo *infos, int count, const BendSeeds *seeds, int n) {
  (void)ix; (void)infos; (void)count; (void)seeds; (void)n;
  asem_fail("unexpected sol_invoke_signed_c");
  return 1;
}

/* ---- Effect helper boundary ---------------------------------------------- */
static unsigned asem_slot(const AsemEffect *base, const AsemEffect *effect) {
  long slot = effect - base;
  if (slot < 0 || slot >= ASEM_SLOTS) asem_fail("effect pointer outside the adapter's effect array");
  return (unsigned)slot;
}
static u64 asem_custody(Account *accounts, const u8 *program, u8 *bump) {
  asem_event("c%u", (unsigned)(accounts[0].key == asem_state_key && !memcmp(program, asem_program, 32)));
  *bump = ASEM_BUMP;
  return asem.custody;
}
static u64 asem_validate(const AsemEffect *base, const AsemEffect *effect, Account *accounts, unsigned count) {
  unsigned slot = asem_slot(base, effect);
  asem_event("v%u:%u:%u", slot, (unsigned)effect->active,
    (unsigned)(count == asem.count && accounts[0].key == asem_state_key));
  return asem.validate[slot];
}
static u64 asem_execute(const AsemEffect *base, const AsemEffect *effect, Account *accounts, unsigned count, u8 bump) {
  unsigned slot = asem_slot(base, effect);
  asem_event("x%u:%u", slot,
    (unsigned)(count == asem.count && accounts[0].key == asem_state_key && bump == ASEM_BUMP));
  if (asem.execute[slot]) return asem.execute[slot];
  ++asem_executed; /* An external effect that the adapter cannot undo. */
  return 0;
}
#endif

/* ---- Codec and root boundary --------------------------------------------- */
static int asem_state_decode(const unsigned char *p, unsigned long long n, ASEM_STATE_T *out) {
  if (p == asem_state_data + ASEM_HEADER_BYTES) asem_event("A%u", (unsigned)(n == ASEM_PAYLOAD_BYTES));
  else {
    unsigned zero = n == ASEM_PAYLOAD_BYTES;
    for (unsigned long long i = 0; zero && i < n; ++i) zero = p[i] == 0;
    asem_event("E%u", zero);
  }
  memset(out, 0, sizeof(*out));
  int ok = ASEM_STATE_DECODE(p, n, out);
  return asem.state_decode_fail ? 0 : ok;
}
static int asem_ix_decode(const unsigned char *p, unsigned long long n, ASEM_IX_T *out) {
  asem_event("i%u", (unsigned)(p == asem_ix + 1));
  memset(out, 0, sizeof(*out));
  int ok = ASEM_IX_DECODE(p, n, out);
  return asem.ix_decode_fail ? 0 : ok;
}
static int asem_state_encode(unsigned char *p, unsigned long long n, const ASEM_STATE_T *value) {
  asem_event("e");
  int ok = ASEM_STATE_ENCODE(p, n, value);
  return asem.encode_fail ? 0 : ok;
}
static ASEM_OUT_T asem_root(ASEM_CTX_T context, ASEM_STATE_T state, ASEM_IX_T instruction) {
#define ASEM_WORD(i) (context.as.c0.f0.as.c0.f##i == (u32)read_le(asem_actor_key + 4 * i, 4))
  unsigned key = ASEM_WORD(0) && ASEM_WORD(1) && ASEM_WORD(2) && ASEM_WORD(3) &&
    ASEM_WORD(4) && ASEM_WORD(5) && ASEM_WORD(6) && ASEM_WORD(7);
#undef ASEM_WORD
  unsigned slot = context.as.c0.f2.as.c0.f0 == (u32)ASEM_SLOT &&
    context.as.c0.f2.as.c0.f1 == (u32)(ASEM_SLOT >> 32);
  asem_event("r%u:%u:%u", (unsigned)context.as.c0.f1, key, slot);
  ASEM_OUT_T outcome = ASEM_ROOT(context, state, instruction);
  if (asem.root_mode == 1) ASEM_SET_REJECT(outcome, asem.root_code);
  else if (asem.root_mode == 2) outcome.tag = ASEM_BAD_TAG;
  else if (asem.root_mode == 3) ASEM_SPOIL_EFFECTS(outcome);
  else if (asem.root_mode == 4) ASEM_SWAP_EFFECTS(outcome);
  return outcome;
}

/* ---- Scenario driver ------------------------------------------------------ */
u64 entrypoint(const u8 *input);

/* Every byte depends on its position, so a permuted or shifted read differs. */
static void asem_key(u8 *out, unsigned index) {
  for (unsigned j = 0; j < 32; ++j) out[j] = (u8)(0x20 + index + 7 * j);
}
static size_t asem_hex(FILE *file, u8 *out) {
  char text[2 * ASEM_BYTES + 2];
  if (fscanf(file, "%8193s", text) != 1) asem_fail("missing hex field");
  if (!strcmp(text, "-")) return 0;
  size_t n = strlen(text);
  if (n % 2 || n / 2 > ASEM_BYTES) asem_fail("bad hex field");
  for (size_t i = 0; i < n / 2; ++i) {
    unsigned byte;
    if (sscanf(text + 2 * i, "%2x", &byte) != 1) asem_fail("bad hex digit");
    out[i] = (u8)byte;
  }
  return n / 2;
}
static void asem_print_hex(const u8 *bytes, size_t n) {
  if (!n) putchar('-');
  for (size_t i = 0; i < n; ++i) printf("%02x", bytes[i]);
}
static int asem_read(FILE *file) {
  unsigned long long size, custody, code;
  memset(&asem, 0, sizeof(asem));
  if (fscanf(file, "%ld", &asem.id) != 1) return 0;
  if (fscanf(file, "%u %d %d %d %u %u %u %u %u %llu %llu %u %u %u %u %llu %u",
      &asem.count, &asem.dup_marker, &asem.dup_a, &asem.dup_b, &asem.owner_fault,
      &asem.executable, &asem.writable, &asem.state_signer, &asem.actor_signer, &size, &custody,
      &asem.state_decode_fail, &asem.ix_decode_fail, &asem.clock_fail, &asem.root_mode, &code,
      &asem.encode_fail) != 17) asem_fail("bad scenario");
  asem.state_size = size; asem.custody = custody; asem.root_code = (u32)code;
  for (unsigned i = 0; i < 2 * ASEM_SLOTS; ++i) {
    unsigned long long value;
    if (fscanf(file, "%llu", &value) != 1) asem_fail("bad effect script");
    (i < ASEM_SLOTS ? asem.validate : asem.execute)[i % ASEM_SLOTS] = value;
  }
  asem.data_len = asem_hex(file, asem.data);
  asem.ix_len = asem_hex(file, asem.ix);
  return 1;
}

/* Serialize the scenario in the aligned loader layout read by solana_min.h.
 * The allocation is exact, so a read past the program id is an ASan error. */
static void asem_run(void) {
  if (asem.count > 16 || asem.state_size > ASEM_BYTES) asem_fail("scenario exceeds harness bounds");
  size_t sizes[16], total = 8;
  for (unsigned i = 0; i < asem.count; ++i) {
    sizes[i] = i == 0 ? (size_t)asem.state_size : 8;
    total += ((88 + sizes[i] + 10240 + 7) & ~(size_t)7) + 8;
  }
  total += 8 + asem.ix_len + 32;
  u8 *input = calloc(1, total), *pristine = malloc(total);
  if (!input || !pristine || ((size_t)input & 7)) asem_fail("allocation");
  memset(asem_program, 0xEE, 32); asem_program[31] = 1;
  write_le(input, asem.count, 8);
  u8 *p = input + 8;
  size_t data_offset = 0;
  asem_state_data = asem_ix = asem_actor_key = asem_state_key = 0;
  for (unsigned i = 0; i < asem.count; ++i) {
    p[0] = (int)i == asem.dup_marker ? 0 : 255;
    p[1] = i == 0 ? asem.state_signer != 0 : i == 1 ? asem.actor_signer != 0 : 0;
    p[2] = i == 0 ? asem.writable != 0 : 1;
    p[3] = i == 0 ? asem.executable != 0 : i == 2;
    asem_key(p + 8, (int)i == asem.dup_b && asem.dup_a >= 0 ? (unsigned)asem.dup_a : i);
    if (i == 0) {
      memcpy(p + 40, asem_program, 32);
      if (asem.owner_fault > 32) asem_fail("owner fault out of range");
      if (asem.owner_fault) p[40 + asem.owner_fault - 1] ^= 1;
      size_t n = asem.data_len < sizes[0] ? asem.data_len : sizes[0];
      memcpy(p + 88, asem.data, n);
      asem_state_data = p + 88; asem_state_key = p + 8; data_offset = (size_t)(p + 88 - input);
    } else memset(p + 40, 0x55, 32);
    if (i == 1) asem_actor_key = p + 8;
    write_le(p + 72, 1000 + i, 8);
    write_le(p + 80, sizes[i], 8);
    p += ((88 + sizes[i] + 10240 + 7) & ~(size_t)7) + 8;
  }
  write_le(p, asem.ix_len, 8);
  asem_ix = p + 8;
  memcpy(p + 8, asem.ix, asem.ix_len);
  memcpy(p + 8 + asem.ix_len, asem_program, 32);
  if ((size_t)(p + 8 + asem.ix_len + 32 - input) != total) asem_fail("layout");
  memcpy(pristine, input, total);

  asem_trace_len = 0; asem_trace[0] = 0; asem_executed = 0;
  asem_return_len = 0; asem_return_calls = 0;
  u64 code = entrypoint(input);

  /* Any byte written outside the nominal state-account region is reported. */
  unsigned outside = 0;
  for (size_t i = 0; i < total; ++i)
    if (input[i] != pristine[i] && !(data_offset && i >= data_offset && i < data_offset + ASEM_TOTAL)) outside = 1;
  printf("%ld %llu %s ", asem.id, code, asem_trace_len ? asem_trace : "-");
  if (data_offset && data_offset + ASEM_TOTAL <= total) asem_print_hex(input + data_offset, ASEM_TOTAL);
  else putchar('-');
  putchar(' ');
  if (asem_return_calls) { printf("%u:", asem_return_calls); asem_print_hex(asem_return, (size_t)asem_return_len); }
  else putchar('-');
  printf(" %u %u\n", asem_executed, outside);
  fflush(stdout);
  free(input); free(pristine);
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  FILE *file = fopen(argv[1], "r");
  if (!file) return 2;
  while (asem_read(file)) asem_run();
  fclose(file);
  puts("done");
  return 0;
}
