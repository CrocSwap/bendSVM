/* Native boundary harness for tests/multi-adapter-semantics.ts.
 *
 * The including unit includes generated Bend types/codecs, sets MAS_* layout
 * macros, includes this file, redirects only ABI/syscall/effect boundaries,
 * and then includes the emitted ABI 2 adapter text unchanged. The loader,
 * read_le/equal_key, field checks, actual codecs, Bend root, effect extraction,
 * commit copies and reply encoding remain the emitted/runtime C.
 *
 * Mocked boundaries: Clock/return-data syscalls, custody derivation, and token
 * or CPI validate/execute helpers. The out-of-count CPI meta check is performed
 * by mas_validate below; this does not execute runtime/bend_cpi.h. Codec
 * failures, root rejection/tag errors, and malformed effect extraction are
 * explicit per-scenario scripts. The executor mock cannot establish rollback.
 */
#pragma once
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "solana_min.h"
#if MAS_EFFECTS == 1
#include "token.h"
typedef BendTransfer MasEffect;
#elif MAS_EFFECTS == 2
#include <bend_cpi.h>
typedef BendInvoke MasEffect;
#endif

#define MAS_MAX_FIELDS 4
#define MAS_MAX_BYTES 1024
#define MAS_MAX_ACCOUNTS 16
#define MAS_HELPER_EFFECT_LIMIT 8
#define MAS_CLOCK_SLOT 0x1122334455667788ULL
#define MAS_PROGRAM_FILL 0xEEu

typedef struct {
  long id;
  unsigned count;
  int alias_index, dup_a, dup_b;
  unsigned actor_signer;
  int owner_field, owner_byte, executable_field, writable_field, signer_field;
  int size_field, size_delta;
  int data_fault_field, data_fault_offset, data_fault_xor;
  int binding_field, binding_chunk;
  int decode_field, ix_decode_fail, clock_fail;
  u64 custody;
  unsigned custody_bump;
  unsigned root_mode;
  u32 root_code;
  int encode_field;             /* -2 reply encode, -1 none, else state-field ordinal. */
  int validate_slot;
  u64 validate_error;
  int execute_slot;
  u64 execute_error;
  size_t ix_length, ix_bytes;
  u8 data[MAS_MAX_FIELDS][MAS_MAX_BYTES];
  size_t data_len[MAS_MAX_FIELDS];
  u8 ix[MAS_MAX_BYTES];
} MasScenario;

static MasScenario mas;
static char mas_trace[16384];
static size_t mas_trace_len;
static unsigned mas_raw_custody, mas_raw_validate, mas_raw_execute, mas_raw_return;
static unsigned mas_decode_ordinal, mas_encode_ordinal;
static unsigned mas_executed;
static u8 mas_program[32], mas_return[MAS_MAX_BYTES];
static u64 mas_return_len;
static const u8 *mas_data_ptr[MAS_MAX_FIELDS];
static u8 *mas_input_base, *mas_pristine;
static unsigned mas_state_index[MAS_MAX_FIELDS] = MAS_STATE_INDEX_VALUES;
static size_t mas_state_bytes[MAS_MAX_FIELDS] = MAS_STATE_BYTE_VALUES;

static void mas_fail(const char *message) {
  fprintf(stderr, "multi-adapter-semantics harness: %s (scenario %ld)\n", message, mas.id);
  exit(3);
}
__attribute__((format(printf, 1, 2)))
static void mas_event(const char *format, ...) {
  va_list args;
  if (mas_trace_len) mas_trace[mas_trace_len++] = ',';
  va_start(args, format);
  int n = vsnprintf(mas_trace + mas_trace_len, sizeof(mas_trace) - mas_trace_len, format, args);
  va_end(args);
  if (n < 0 || (size_t)n >= sizeof(mas_trace) - mas_trace_len - 1) mas_fail("trace overflow");
  mas_trace_len += (size_t)n;
}
static void mas_hex_text(const u8 *bytes, size_t n, char *out, size_t capacity) {
  static const char h[] = "0123456789abcdef";
  if (2 * n + 1 > capacity) mas_fail("hex text overflow");
  for (size_t i = 0; i < n; ++i) { out[2*i] = h[bytes[i] >> 4]; out[2*i+1] = h[bytes[i] & 15]; }
  out[2*n] = 0;
}
static size_t mas_append(char *out, size_t capacity, size_t used, const char *format, ...) {
  if (used >= capacity) mas_fail("effect observation overflow");
  if (used) out[used++] = ';';
  if (used >= capacity) mas_fail("effect observation overflow");
  va_list args; va_start(args, format);
  int n = vsnprintf(out + used, capacity - used, format, args);
  va_end(args);
  if (n < 0 || (size_t)n >= capacity - used) mas_fail("effect observation overflow");
  return used + (size_t)n;
}
static size_t mas_append_hex(char *out, size_t capacity, size_t used, const u8 *bytes, size_t length) {
  char hex[2 * MAS_MAX_BYTES + 1];
  mas_hex_text(bytes, length, hex, sizeof(hex));
  return mas_append(out, capacity, used, "%s", hex);
}
#if MAS_EFFECTS
static void mas_effect_text(const MasEffect *effect, char *out, size_t capacity) {
  size_t used = 0;
#if MAS_EFFECTS == 1
  used = mas_append(out, capacity, used, "%u", effect->active);
  used = mas_append(out, capacity, used, "%u", effect->source);
  used = mas_append(out, capacity, used, "%u", effect->destination);
  used = mas_append(out, capacity, used, "%u", effect->mint);
  used = mas_append(out, capacity, used, "%u", effect->authority);
  used = mas_append(out, capacity, used, "%u", effect->recipient);
  used = mas_append_hex(out, capacity, used, effect->mint_key, sizeof(effect->mint_key));
  used = mas_append_hex(out, capacity, used, effect->recipient_key, sizeof(effect->recipient_key));
  used = mas_append(out, capacity, used, "%llu", (unsigned long long)effect->amount);
  used = mas_append(out, capacity, used, "%u", effect->initialize);
  used = mas_append(out, capacity, used, "%u", effect->source_bound);
  used = mas_append(out, capacity, used, "%u", effect->destination_bound);
  used = mas_append(out, capacity, used, "%u", effect->fresh_destination);
  used = mas_append_hex(out, capacity, used, effect->source_key, sizeof(effect->source_key));
  used = mas_append_hex(out, capacity, used, effect->destination_key, sizeof(effect->destination_key));
#elif MAS_EFFECTS == 2
  used = mas_append(out, capacity, used, "%u", effect->active);
  used = mas_append(out, capacity, used, "%u", effect->program);
  used = mas_append(out, capacity, used, "%u", effect->length);
  used = mas_append(out, capacity, used, "%u", effect->count);
  used = mas_append_hex(out, capacity, used, effect->program_key, sizeof(effect->program_key));
  used = mas_append_hex(out, capacity, used, effect->data, sizeof(effect->data));
  for (unsigned i = 0; i < 8; ++i) {
    used = mas_append(out, capacity, used, "%u", effect->metas[i].index);
    used = mas_append(out, capacity, used, "%u", effect->metas[i].writable);
    used = mas_append(out, capacity, used, "%u", effect->metas[i].signer);
    used = mas_append_hex(out, capacity, used, effect->metas[i].key, sizeof(effect->metas[i].key));
  }
#endif
  out[used] = 0;
}
#endif

#if MAS_EFFECTS
static size_t mas_pointer_offset(const void *pointer) {
  uintptr_t base = (uintptr_t)mas_input_base, value = (uintptr_t)pointer;
  return value >= base ? (size_t)(value - base) : SIZE_MAX;
}
/* Observe keys, owners, flags, size, exact loader pointer identity and the
 * rent_epoch value supplied at every token/CPI helper boundary. */
static void mas_accounts_text(Account *accounts, unsigned count, char *out, size_t capacity) {
  size_t used = 0;
  out[0] = 0;
  for (unsigned i = 0; i < count; ++i) {
    char key[65], owner[65];
    mas_hex_text(accounts[i].key, 32, key, sizeof(key));
    mas_hex_text(accounts[i].owner, 32, owner, sizeof(owner));
    int n = snprintf(out + used, capacity - used, "%s%u~%s~%s~%u~%u~%u~%llu~%zu~%zu~%llu",
      i ? ";" : "", i, key, owner, accounts[i].signer, accounts[i].writable,
      accounts[i].executable, (unsigned long long)accounts[i].size,
      mas_pointer_offset(accounts[i].data), mas_pointer_offset(accounts[i].lamports),
      (unsigned long long)accounts[i].rent_epoch);
    if (n < 0 || (size_t)n >= capacity - used) mas_fail("account identity observation overflow");
    used += (size_t)n;
  }
}
#endif

/* These order-sensitive wrappers always call the actual generated field
 * codec. They also distinguish fields sharing the same C type. */
static int mas_decode_field(unsigned codec, const u8 *p, u64 n, void *out) {
  unsigned i = mas_decode_ordinal++;
  mas_event("d%u:c%u:%u:%llu", i, codec, (unsigned)(p != NULL), (unsigned long long)n);
  int ok = 0;
  switch (codec) {
    case 0: ok = MAS_CODEC_DECODE_0(p, n, (MAS_CODEC_TYPE_0 *)out); break;
#if MAS_CODEC_COUNT > 1
    case 1: ok = MAS_CODEC_DECODE_1(p, n, (MAS_CODEC_TYPE_1 *)out); break;
#endif
#if MAS_CODEC_COUNT > 2
    case 2: ok = MAS_CODEC_DECODE_2(p, n, (MAS_CODEC_TYPE_2 *)out); break;
#endif
#if MAS_CODEC_COUNT > 3
    case 3: ok = MAS_CODEC_DECODE_3(p, n, (MAS_CODEC_TYPE_3 *)out); break;
#endif
    default: mas_fail("unexpected extra state field decoder call");
  }
  return mas.decode_field == (int)i ? 0 : ok;
}
static int mas_encode_field(unsigned codec, u8 *p, u64 n, const void *value) {
  unsigned i = mas_encode_ordinal++;
  mas_event("o%u:c%u:%llu", i, codec, (unsigned long long)n);
  int ok = 0;
  switch (codec) {
    case 0: ok = MAS_CODEC_ENCODE_0(p, n, (const MAS_CODEC_TYPE_0 *)value); break;
#if MAS_CODEC_COUNT > 1
    case 1: ok = MAS_CODEC_ENCODE_1(p, n, (const MAS_CODEC_TYPE_1 *)value); break;
#endif
#if MAS_CODEC_COUNT > 2
    case 2: ok = MAS_CODEC_ENCODE_2(p, n, (const MAS_CODEC_TYPE_2 *)value); break;
#endif
#if MAS_CODEC_COUNT > 3
    case 3: ok = MAS_CODEC_ENCODE_3(p, n, (const MAS_CODEC_TYPE_3 *)value); break;
#endif
    default: mas_fail("unexpected extra state field encoder call");
  }
  return mas.encode_field == (int)i ? 0 : ok;
}

static int mas_decode_ix(const u8 *p, u64 n, MAS_IX_TYPE *out) {
  mas_event("i:%u:%llu", (unsigned)(p != NULL), n);
  int ok = MAS_RAW_IX_DECODE(p, n, out);
  return mas.ix_decode_fail ? 0 : ok;
}
static int mas_encode_state(u8 *p, u64 n, const MAS_STATE_TYPE *value) {
  mas_event("q:%llu", n);
  int ok = MAS_RAW_STATE_ENCODE(p, n, value);
  return mas.encode_field == -2 ? 0 : ok;
}

/* ---- Root and execution boundaries -------------------------------------- */
static MAS_OUT_TYPE mas_root(MAS_CONTEXT_TYPE context, MAS_STATE_TYPE state, MAS_IX_TYPE instruction) {
  u8 field_bytes[MAS_MAX_FIELDS][MAS_MAX_BYTES];
  char field_hex[MAS_MAX_FIELDS][2 * MAS_MAX_BYTES + 1];
  u8 instruction_bytes[MAS_MAX_BYTES];
  char instruction_hex[2 * MAS_MAX_BYTES + 1];
  if (!MAS_RAW_IX_ENCODE(instruction_bytes, MAS_IX_PAYLOAD_BYTES, &instruction))
    mas_fail("could not observe actual root instruction input");
  mas_hex_text(instruction_bytes, MAS_IX_PAYLOAD_BYTES, instruction_hex, sizeof(instruction_hex));
  mas_event("u:%s", instruction_hex);
  for (unsigned i = 0; i < MAS_FIELDS; ++i) {
    int ok = 0;
    switch (i) {
      case 0: ok = MAS_RAW_ENCODE_0(field_bytes[0], MAS_FIELD_BYTES_0, &MAS_GET_FIELD_0(state)); break;
#if MAS_FIELDS > 1
      case 1: ok = MAS_RAW_ENCODE_1(field_bytes[1], MAS_FIELD_BYTES_1, &MAS_GET_FIELD_1(state)); break;
#endif
#if MAS_FIELDS > 2
      case 2: ok = MAS_RAW_ENCODE_2(field_bytes[2], MAS_FIELD_BYTES_2, &MAS_GET_FIELD_2(state)); break;
#endif
#if MAS_FIELDS > 3
      case 3: ok = MAS_RAW_ENCODE_3(field_bytes[3], MAS_FIELD_BYTES_3, &MAS_GET_FIELD_3(state)); break;
#endif
    }
    if (!ok) mas_fail("could not observe actual root field input");
    mas_hex_text(field_bytes[i], MAS_FIELD_BYTES(i), field_hex[i], sizeof(field_hex[i]));
  }
  char actor_hex[65]; mas_hex_text(MAS_CONTEXT_ACTOR_BYTES(context), 32, actor_hex, sizeof(actor_hex));
  mas_event("r%u:%s:%llu:%s", (unsigned)MAS_CONTEXT_SIGNED(context), actor_hex,
            (unsigned long long)MAS_CONTEXT_SLOT(context), field_hex[0]);
#if MAS_FIELDS > 1
  mas_event("f1:%s", field_hex[1]);
#endif
#if MAS_FIELDS > 2
  mas_event("f2:%s", field_hex[2]);
#endif
#if MAS_FIELDS > 3
  mas_event("f3:%s", field_hex[3]);
#endif
  MAS_OUT_TYPE outcome = MAS_REAL_ROOT(context, state, instruction);
  if (mas.root_mode == 1) MAS_SET_REJECT(outcome, mas.root_code);
  else if (mas.root_mode == 2) outcome.tag = MAS_BAD_TAG;
  else if (mas.root_mode == 3) MAS_SPOIL_EFFECTS(outcome);
#if MAS_EFFECTS == 2
  else if (mas.root_mode == 4) MAS_FIRST_CPI_SLOT_NONE(outcome);
#endif
  return outcome;
}

void sol_set_return_data(const u8 *bytes, u64 length) {
  ++mas_raw_return; /* Record the raw syscall before bounded inspection. */
  mas_event("R:%llu", (unsigned long long)length);
  if (length > sizeof(mas_return)) mas_fail("return data exceeds harness capacity");
  memcpy(mas_return, bytes, (size_t)length);
  mas_return_len = length;
}
u64 sol_get_clock_sysvar(void *out) {
  struct { u64 slot; long long start; u64 epoch, leader; long long unix_timestamp; } clock = {MAS_CLOCK_SLOT, 1, 2, 3, 4};
  mas_event("k"); memcpy(out, &clock, sizeof(clock)); return mas.clock_fail;
}

#if MAS_EFFECTS
u64 sol_try_find_program_address(const BendSeed *seeds, int count, const u8 *program, u8 *key, u8 *bump) {
  (void)seeds; (void)count; (void)program; (void)key; (void)bump;
  mas_fail("unexpected PDA syscall escaped the custody mock"); return 1;
}
u64 sol_invoke_signed_c(const BendInstruction *ix, const BendAccountInfo *infos, int count, const BendSeeds *seeds, int n) {
  (void)ix; (void)infos; (void)count; (void)seeds; (void)n;
  mas_fail("unexpected invoke syscall escaped the executor mock"); return 1;
}
static u64 mas_custody(Account *accounts, const u8 *program, u8 *bump) {
  ++mas_raw_custody;
  mas_event("c:%u:%u", (unsigned)(accounts[0].key == mas_input_base + 16 &&
                                   !memcmp(program, mas_program, 32)), mas.custody_bump);
  *bump = (u8)mas.custody_bump; return mas.custody;
}
static unsigned mas_effect_slot(const MasEffect *base, const MasEffect *effect) {
  uintptr_t b = (uintptr_t)base, e = (uintptr_t)effect;
  if (e < b || (e - b) % sizeof(*base) || (e - b) / sizeof(*base) >= MAS_HELPER_EFFECT_LIMIT)
    mas_fail("effect helper received a pointer outside the adapter array");
  return (unsigned)((e - b) / sizeof(*base));
}
static u64 mas_validate(const MasEffect *base, const MasEffect *effect, Account *accounts, unsigned count) {
  ++mas_raw_validate; /* Raw call count precedes all effect/account inspection. */
  unsigned slot = mas_effect_slot(base, effect);
  unsigned active = (unsigned)effect->active;
  unsigned base_ok = count <= MAS_MAX_ACCOUNTS && count >= MAS_MIN_ACCOUNTS &&
    accounts[0].key != NULL && accounts[0].key == mas_input_base + 16;
  char observed[4096], account_view[8192];
  mas_effect_text(effect, observed, sizeof(observed));
  mas_accounts_text(accounts, count, account_view, sizeof(account_view));
  mas_event("v%u:%u:%u:%u:%s:%s", slot, active, count, base_ok, observed, account_view);
#if MAS_EFFECTS == 2
  if (effect->active) for (unsigned i = 0; i < effect->count && i < 8; ++i)
    if (effect->metas[i].index >= count) return 21;
#endif
  return mas.validate_slot == (int)slot ? mas.validate_error : 0;
}
static u64 mas_execute(const MasEffect *base, const MasEffect *effect, Account *accounts, unsigned count, u8 bump) {
  ++mas_raw_execute; /* Raw call count precedes all effect/account inspection. */
  unsigned slot = mas_effect_slot(base, effect);
  char observed[4096], account_view[8192];
  mas_effect_text(effect, observed, sizeof(observed));
  mas_accounts_text(accounts, count, account_view, sizeof(account_view));
  mas_event("x%u:%u:%u:%u:%s:%s", slot, (unsigned)effect->active, count,
            (unsigned)bump, observed, account_view);
  if (mas.execute_slot == (int)slot && mas.execute_error) return mas.execute_error;
  ++mas_executed; /* External effect; only Solana can roll it back. */
  return 0;
}
#endif

/* ---- Serialized loader driver ------------------------------------------- */
u64 entrypoint(const u8 *input);
static void mas_key(u8 *out, unsigned index) {
  for (unsigned j = 0; j < 32; ++j) out[j] = (u8)(0x20 + index + 7 * j);
}
static size_t mas_read_hex(FILE *file, u8 *out) {
  char text[2 * MAS_MAX_BYTES + 2];
  if (fscanf(file, "%2049s", text) != 1) mas_fail("missing hex field");
  if (!strcmp(text, "-")) return 0;
  size_t n = strlen(text);
  if ((n & 1) || n / 2 > MAS_MAX_BYTES) {
    fprintf(stderr, "multi-adapter-semantics harness: bad hex field length %zu: %.80s\n", n, text);
    mas_fail("bad hex field");
  }
  for (size_t i = 0; i < n / 2; ++i) {
    unsigned byte; if (sscanf(text + 2 * i, "%2x", &byte) != 1) mas_fail("bad hex digit"); out[i] = (u8)byte;
  }
  return n / 2;
}
static void mas_print_hex(const u8 *bytes, size_t n) {
  if (!n) { putchar('-'); return; }
  for (size_t i = 0; i < n; ++i) printf("%02x", bytes[i]);
}
static int mas_read(FILE *file) {
  unsigned long long custody, validation, execution, ix_length;
  memset(&mas, 0, sizeof(mas));
  if (fscanf(file, "%ld", &mas.id) != 1) return 0;
  if (fscanf(file, "%u %d %d %d %u "
                   "%d %d %d %d %d %d %d %d %d %d %d %d %d %d %d "
                   "%u %llu %u %u %d %d %llu %d %llu %llu",
      &mas.count, &mas.alias_index, &mas.dup_a, &mas.dup_b, &mas.actor_signer,
      &mas.owner_field, &mas.owner_byte, &mas.executable_field, &mas.writable_field, &mas.signer_field,
      &mas.size_field, &mas.size_delta, &mas.data_fault_field, &mas.data_fault_offset, &mas.data_fault_xor,
      &mas.binding_field, &mas.binding_chunk, &mas.decode_field, &mas.ix_decode_fail, &mas.clock_fail,
      &mas.root_mode, &custody, &mas.custody_bump, &mas.root_code, &mas.encode_field, &mas.validate_slot, &validation,
      &mas.execute_slot, &execution, &ix_length) != 30) mas_fail("bad scenario header");
  mas.custody = (u64)custody; mas.validate_error = (u64)validation; mas.execute_error = (u64)execution;
  mas.ix_length = (size_t)ix_length;
  for (unsigned i = 0; i < MAS_FIELDS; ++i) mas.data_len[i] = mas_read_hex(file, mas.data[i]);
  mas.ix_bytes = mas_read_hex(file, mas.ix);
  if (mas.ix_length > MAS_MAX_BYTES || mas.ix_bytes > MAS_MAX_BYTES || mas.count > MAS_MAX_ACCOUNTS)
    mas_fail("scenario exceeds bounded harness input");
  return 1;
}

static size_t mas_account_advance(size_t size) {
  return ((88 + size + 10240 + 7) & ~(size_t)7) + 8;
}
static void mas_run(void) {
  size_t sizes[MAS_MAX_ACCOUNTS], total = 8;
  memset(mas_data_ptr, 0, sizeof(mas_data_ptr));
  for (unsigned i = 0; i < mas.count; ++i) {
    sizes[i] = 8;
    for (unsigned f = 0; f < MAS_FIELDS; ++f) if (i == mas_state_index[f]) {
      long z = (long)mas_state_bytes[f] + (mas.size_field == (int)f ? mas.size_delta : 0);
      sizes[i] = z < 0 ? 0 : (size_t)z;
    }
    total += mas_account_advance(sizes[i]);
  }
  total += 8 + mas.ix_length + 32;
  u8 *input = calloc(1, total), *pristine = malloc(total);
  if (!input || !pristine || ((uintptr_t)input & 7)) mas_fail("loader allocation");
  mas_input_base = input; mas_pristine = pristine;
  memset(mas_program, MAS_PROGRAM_FILL, 32); mas_program[31] = 1;
  write_le(input, mas.count, 8); u8 *p = input + 8;
  for (unsigned i = 0; i < mas.count; ++i) {
    p[0] = (int)i == mas.alias_index ? 0 : 255;
    p[1] = i == 1 ? mas.actor_signer != 0 : 0;
    p[2] = 1; p[3] = 0;
    if (i == 0) {
      if (mas.writable_field == 0) p[2] = 0;
      if (mas.executable_field == 0) p[3] = 1;
    }
    int field = -1;
    for (unsigned f = 0; f < MAS_FIELDS; ++f) if (i == mas_state_index[f]) field = (int)f;
    if (field >= 0) {
      unsigned f = (unsigned)field;
      if (mas.writable_field == (int)f) p[2] = 0;
      if (mas.executable_field == (int)f) p[3] = 1;
      p[1] = mas.signer_field == (int)f ? 0 : 1;
      memcpy(p + 40, mas_program, 32);
      if (mas.owner_field == (int)f && mas.owner_byte >= 0 && mas.owner_byte < 32)
        p[40 + mas.owner_byte] ^= (u8)(1u << (f % 7));
      mas_key(p + 8, i == (unsigned)mas.dup_b && mas.dup_a >= 0 ? (unsigned)mas.dup_a : i);
      size_t copy = mas.data_len[f] < MAS_MAX_BYTES ? mas.data_len[f] : MAS_MAX_BYTES;
      memcpy(p + 88, mas.data[f], copy);
      if (mas.data_fault_field == (int)f && mas.data_fault_offset >= 0 && (size_t)mas.data_fault_offset < mas_state_bytes[f])
        p[88 + mas.data_fault_offset] ^= (u8)mas.data_fault_xor;
      if (mas.binding_field == (int)f && f > 0 && mas.binding_chunk >= 0 && mas.binding_chunk < 4)
        p[88 + 20 + 8 * mas.binding_chunk] ^= 0x80;
      mas_data_ptr[f] = p + 88;
    } else {
      memset(p + 40, 0x55, 32);
      mas_key(p + 8, i == (unsigned)mas.dup_b && mas.dup_a >= 0 ? (unsigned)mas.dup_a : i);
    }
    write_le(p + 72, 1000 + i, 8); write_le(p + 80, sizes[i], 8);
    u8 *rent = (u8 *)((((uintptr_t)(p + 88) + sizes[i] + 10240u + 7u) & ~(uintptr_t)7u));
    write_le(rent, 0x6d61730000000000ULL + (u64)i * 0x101u, 8);
    p += mas_account_advance(sizes[i]);
  }
  write_le((u8 *)p, mas.ix_length, 8);
  u8 *ix = (u8 *)p + 8;
  memcpy(ix, mas.ix, mas.ix_bytes < mas.ix_length ? mas.ix_bytes : mas.ix_length);
  memcpy(ix + mas.ix_length, mas_program, 32);
  if ((size_t)(ix + mas.ix_length + 32 - input) != total) mas_fail("loader layout mismatch");
  memcpy(pristine, input, total);

  mas_trace_len = 0; mas_trace[0] = 0; mas_executed = 0; mas_decode_ordinal = mas_encode_ordinal = 0;
  mas_raw_custody = mas_raw_validate = mas_raw_execute = mas_raw_return = 0; mas_return_len = 0;
  u64 rc = entrypoint(input);
  /* These are the real serialized account-data objects passed through
   * read_account/Account.data, observed in place after entrypoint returns. */
  unsigned outside = 0;
  for (size_t i = 0; i < total; ++i) if (input[i] != pristine[i]) {
    unsigned commit = 0;
    for (unsigned f = 0; f < MAS_FIELDS; ++f)
      if (mas_data_ptr[f] && input + i >= mas_data_ptr[f] && input + i < mas_data_ptr[f] + mas_state_bytes[f]) commit = 1;
    if (!commit) outside = 1;
  }
  printf("%ld %llu %s", mas.id, (unsigned long long)rc, mas_trace_len ? mas_trace : "-");
  for (unsigned f = 0; f < MAS_FIELDS; ++f) { putchar(' '); if (mas_data_ptr[f]) mas_print_hex(mas_data_ptr[f], mas_state_bytes[f]); else putchar('-'); }
  putchar(' ');
  if (mas_raw_return) { printf("%u:", mas_raw_return); mas_print_hex(mas_return, (size_t)mas_return_len); } else putchar('-');
  printf(" %u %u %u %u %u %u\n", mas_executed, outside, mas_raw_custody, mas_raw_validate, mas_raw_execute, mas_raw_return);
  fflush(stdout); free(input); free(pristine);
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  FILE *file = fopen(argv[1], "r"); if (!file) return 2;
  while (mas_read(file)) mas_run(); fclose(file); puts("done"); return 0;
}
