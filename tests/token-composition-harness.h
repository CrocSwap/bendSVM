/*
 * Native driver for the actual generated token adapter entrypoint.
 *
 * The generated program.c supplies the loader parser, storage adapter,
 * codecs, Bend root, effect extraction, runtime custody, token validation,
 * and token execution. This file only supplies deterministic syscall mocks
 * and observes their arguments. It never extracts or orchestrates effects.
 */
#pragma once
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define TC_MAX_ACCOUNTS 12u
#define TC_MAX_CALLS 12u
#define TC_MAX_BYTES 1024u
#define TC_MAX_EVENTS 32u

typedef struct { u64 length; u8 bytes[32]; } TcSeed;
typedef struct {
  u32 index, writable, signer, key_pointer_ok;
  u8 key[32];
} TcMeta;
typedef struct {
  u8 key[32], owner[32];
  u64 lamports, data_length, rent_epoch;
  u32 signer, writable, executable;
  u32 key_pointer_ok, lamports_pointer_ok, data_pointer_ok, owner_pointer_ok;
} TcInfo;
typedef struct {
  int raw_info_count, raw_signer_count;
  u64 raw_meta_count, instruction_length, syscall_error;
  u32 info_count, meta_count, signer_count, signer_seed_count;
  u32 program_pointer_ok, accounts_pointer_present, data_pointer_present;
  u8 program[32], data[16];
  TcSeed signer_seeds[3];
  TcMeta metas[4];
  TcInfo infos[TC_MAX_ACCOUNTS];
} TcCall;
typedef struct {
  int seed_count;
  u64 error;
  u8 program[32], key[32], bump;
  TcSeed seeds[2];
} TcPda;

static Account tc_accounts[TC_MAX_ACCOUNTS];
static u64 tc_pda_error, tc_invoke_error;
static u8 tc_pda_key[32], tc_pda_bump;
static TcPda tc_pda;
static TcCall tc_calls[TC_MAX_CALLS];
static u32 tc_account_count, tc_call_count, tc_clock_calls, tc_return_calls;
static char tc_events[TC_MAX_EVENTS][8];
static u32 tc_event_count;
static u8 tc_return_data[TC_MAX_BYTES];
static u64 tc_return_length;

static void tc_fail(const char *message) {
  fprintf(stderr, "token-composition harness: %s\n", message);
  exit(3);
}
static void tc_event(const char *name) {
  if (tc_event_count >= TC_MAX_EVENTS) tc_fail("too many syscall events");
  snprintf(tc_events[tc_event_count++], sizeof(tc_events[0]), "%s", name);
}
static void tc_hex(const u8 *p, size_t n) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < n; ++i) { putchar(digits[p[i] >> 4]); putchar(digits[p[i] & 15]); }
}
static u32 tc_account_index(const u8 *key) {
  for (u32 i = 0; i < tc_account_count; ++i)
    if (key == tc_accounts[i].key) return i;
  return 0xffffffffu;
}
static void tc_reset_observations(void) {
  memset(&tc_pda, 0, sizeof(tc_pda));
  memset(tc_calls, 0, sizeof(tc_calls));
  memset(tc_return_data, 0, sizeof(tc_return_data));
  tc_call_count = tc_clock_calls = tc_return_calls = tc_event_count = 0;
  tc_return_length = 0;
}

/* Solana syscall boundary: deterministic PDA bytes and bump. */
u64 sol_try_find_program_address(const BendSeed *seeds, int count, const u8 *program,
                                 u8 *key, u8 *bump) {
  tc_event("P");
  tc_pda.seed_count = count;
  tc_pda.error = tc_pda_error;
  if (program) memcpy(tc_pda.program, program, 32);
  for (int i = 0; i < count && i < 2; ++i) {
    tc_pda.seeds[i].length = seeds[i].length;
    if (seeds[i].address && seeds[i].length <= sizeof(tc_pda.seeds[i].bytes))
      memcpy(tc_pda.seeds[i].bytes, seeds[i].address, (size_t)seeds[i].length);
  }
  if (tc_pda_error) return tc_pda_error;
  memcpy(key, tc_pda_key, 32); *bump = tc_pda_bump;
  memcpy(tc_pda.key, tc_pda_key, 32); tc_pda.bump = tc_pda_bump;
  return 0;
}

/* Solana syscall boundary: record the real executor's exact CPI plan. */
u64 sol_invoke_signed_c(const BendInstruction *ix, const BendAccountInfo *infos, int count,
                        const BendSeeds *signer_seeds, int signer_count) {
  if (tc_call_count >= TC_MAX_CALLS) tc_fail("invoke call limit exceeded");
  TcCall *c = &tc_calls[tc_call_count];
  memset(c, 0, sizeof(*c));
  c->raw_info_count = count;
  c->raw_meta_count = ix->count;
  c->raw_signer_count = signer_count;
  c->info_count = count < 0 ? 0u : (u32)count;
  if (c->info_count > TC_MAX_ACCOUNTS) c->info_count = TC_MAX_ACCOUNTS;
  c->meta_count = ix->count > 4 ? 4u : (u32)ix->count;
  c->program_pointer_ok = ix->program == tc_accounts[2].key;
  c->accounts_pointer_present = ix->accounts != NULL;
  c->data_pointer_present = ix->data != NULL;
  c->signer_count = signer_count < 0 ? 0u : (u32)signer_count;
  c->signer_seed_count = signer_seeds && signer_seeds->count <= 3 ? (u32)signer_seeds->count : 0;
  for (u32 i = 0; i < c->signer_seed_count; ++i) {
    c->signer_seeds[i].length = signer_seeds->seeds[i].length;
    if (signer_seeds->seeds[i].address && signer_seeds->seeds[i].length <= sizeof(c->signer_seeds[i].bytes))
      memcpy(c->signer_seeds[i].bytes, signer_seeds->seeds[i].address,
        (size_t)signer_seeds->seeds[i].length);
  }
  c->instruction_length = ix->length;
  c->syscall_error = tc_invoke_error;
  if (ix->program) memcpy(c->program, ix->program, 32);
  if (ix->data && ix->length <= sizeof(c->data)) memcpy(c->data, ix->data, (size_t)ix->length);
  for (u32 i = 0; i < c->meta_count; ++i) {
    const BendAccountMeta *m = &ix->accounts[i];
    TcMeta *d = &c->metas[i];
    d->index = tc_account_index(m->key);
    d->key_pointer_ok = d->index != 0xffffffffu;
    if (m->key) memcpy(d->key, m->key, 32);
    d->writable = m->writable; d->signer = m->signer;
  }
  for (u32 i = 0; i < c->info_count; ++i) {
    const BendAccountInfo *a = &infos[i];
    TcInfo *d = &c->infos[i];
    memcpy(d->key, a->key, 32); memcpy(d->owner, a->owner, 32);
    d->lamports = *a->lamports; d->data_length = a->data_len; d->rent_epoch = a->rent_epoch;
    d->signer = a->signer; d->writable = a->writable; d->executable = a->executable;
    d->key_pointer_ok = a->key == tc_accounts[i].key;
    d->lamports_pointer_ok = a->lamports == tc_accounts[i].lamports;
    d->data_pointer_ok = a->data == tc_accounts[i].data;
    d->owner_pointer_ok = a->owner == tc_accounts[i].owner;
  }
  char event[8]; snprintf(event, sizeof(event), "I%u", tc_call_count);
  tc_event(event); ++tc_call_count;
  return tc_invoke_error;
}

/* Clock and return-data syscalls are also mocked; all adapter logic is real. */
u64 sol_get_clock_sysvar(void *out) {
  struct { u64 slot; long long epoch_start_timestamp; u64 epoch;
    u64 leader_schedule_epoch; long long unix_timestamp; } clock = { 0x1122334455667788ULL, 1, 2, 3, 4 };
  ++tc_clock_calls; tc_event("K"); memcpy(out, &clock, sizeof(clock)); return 0;
}
void sol_set_return_data(const u8 *bytes, u64 length) {
  ++tc_return_calls; tc_event("R");
  if (length > sizeof(tc_return_data)) tc_fail("return data exceeds observation capacity");
  memcpy(tc_return_data, bytes, (size_t)length); tc_return_length = length;
}

static void tc_print_seed(const TcSeed *s) {
  printf("{\"length\":\"%llu\",\"data\":\"", (unsigned long long)s->length);
  size_t n = s->length <= sizeof(s->bytes) ? (size_t)s->length : 0;
  tc_hex(s->bytes, n); printf("\"}");
}
static void tc_print_pda(void) {
  printf("{\"seedCount\":%d,\"error\":\"%llu\",\"program\":\"", tc_pda.seed_count,
    (unsigned long long)tc_pda.error);
  tc_hex(tc_pda.program, 32); printf("\",\"key\":\""); tc_hex(tc_pda.key, 32);
  printf("\",\"bump\":%u,\"seeds\":[", tc_pda.bump);
  for (int i = 0; i < tc_pda.seed_count && i < 2; ++i) {
    if (i) putchar(','); tc_print_seed(&tc_pda.seeds[i]);
  }
  printf("]}");
}
static void tc_print_call(const TcCall *c) {
  printf("{\"rawInfoCount\":%d,\"rawMetaCount\":\"%llu\",\"rawSignerCount\":%d,"
    "\"infoCount\":%u,\"metaCount\":%u,\"programPointerOk\":%u,\"accountsPointerPresent\":%u,"
    "\"dataPointerPresent\":%u,\"signerCount\":%u,\"signerSeedCount\":%u,\"instructionLength\":\"%llu\","
    "\"syscallError\":\"%llu\",\"program\":\"", c->raw_info_count,
    (unsigned long long)c->raw_meta_count, c->raw_signer_count, c->info_count, c->meta_count,
    c->program_pointer_ok, c->accounts_pointer_present, c->data_pointer_present, c->signer_count,
    c->signer_seed_count, (unsigned long long)c->instruction_length, (unsigned long long)c->syscall_error);
  tc_hex(c->program, 32); printf("\",\"data\":\""); tc_hex(c->data, sizeof(c->data));
  printf("\",\"signerSeeds\":[");
  for (u32 i = 0; i < c->signer_seed_count; ++i) { if (i) putchar(','); tc_print_seed(&c->signer_seeds[i]); }
  printf("],\"metas\":[");
  for (u32 i = 0; i < c->meta_count; ++i) {
    const TcMeta *m = &c->metas[i]; if (i) putchar(',');
    printf("{\"index\":%u,\"writable\":%u,\"signer\":%u,\"keyPointerOk\":%u,\"key\":\"",
      m->index, m->writable, m->signer, m->key_pointer_ok);
    tc_hex(m->key, 32); printf("\"}");
  }
  printf("],\"infos\":[");
  for (u32 i = 0; i < c->info_count; ++i) {
    const TcInfo *a = &c->infos[i]; if (i) putchar(',');
    printf("{\"key\":\""); tc_hex(a->key, 32); printf("\",\"owner\":\""); tc_hex(a->owner, 32);
    printf("\",\"lamports\":\"%llu\",\"dataLength\":\"%llu\",\"rentEpoch\":\"%llu\","
      "\"signer\":%u,\"writable\":%u,\"executable\":%u,\"keyPointerOk\":%u,"
      "\"lamportsPointerOk\":%u,\"dataPointerOk\":%u,\"ownerPointerOk\":%u}",
      (unsigned long long)a->lamports, (unsigned long long)a->data_length, (unsigned long long)a->rent_epoch,
      a->signer, a->writable, a->executable, a->key_pointer_ok, a->lamports_pointer_ok,
      a->data_pointer_ok, a->owner_pointer_ok);
  }
  printf("]}");
}

static int tc_run_one(u8 *input, size_t input_length, u32 id) {
  tc_reset_observations();
  u64 raw_count = read_le(input, 8);
  if (raw_count > TC_MAX_ACCOUNTS) tc_fail("account count exceeds generated executor bound");
  tc_account_count = (u32)raw_count;
  const u8 *p = input + 8;
  for (u32 i = 0; i < tc_account_count; ++i) {
    p = read_account(p, &tc_accounts[i]);
    if (!p) tc_fail("test input contains a duplicate-account marker");
  }
  if (input_length < 8 + 88 + 25) tc_fail("short loader input");
  u8 state_before[TC_MAX_BYTES];
  if (tc_accounts[0].size > sizeof(state_before)) tc_fail("managed state exceeds observation capacity");
  size_t state_length = (size_t)tc_accounts[0].size;
  memcpy(state_before, tc_accounts[0].data, state_length);
  u64 rc = entrypoint(input);
  unsigned state_unchanged = memcmp(state_before, tc_accounts[0].data, state_length) == 0;
  printf("{\"id\":%u,\"rc\":\"%llu\",\"clockCalls\":%u,\"returnCalls\":%u,\"stateUnchanged\":%u,\"stateData\":\"",
    id, (unsigned long long)rc, tc_clock_calls, tc_return_calls, state_unchanged);
  tc_hex(tc_accounts[0].data, state_length);
  printf("\",\"returnData\":");
  if (tc_return_calls) { putchar('"'); tc_hex(tc_return_data, (size_t)tc_return_length); putchar('"'); }
  else printf("null");
  printf(",\"pdaCalls\":%u,\"pda\":", (unsigned)(tc_event_count && !strcmp(tc_events[0], "P")));
  if (tc_event_count && !strcmp(tc_events[0], "P")) tc_print_pda(); else printf("null");
  printf(",\"invokeCalls\":%u,\"events\":[", tc_call_count);
  for (u32 i = 0; i < tc_event_count; ++i) { if (i) putchar(','); printf("\"%s\"", tc_events[i]); }
  printf("],\"calls\":[");
  for (u32 i = 0; i < tc_call_count; ++i) { if (i) putchar(','); tc_print_call(&tc_calls[i]); }
  puts("]}");
  return 0;
}

/* Input records frame syscall controls around a real serialized loader input. */
int main(void) {
  for (;;) {
    u8 header[61];
    size_t got = fread(header, 1, sizeof(header), stdin);
    if (got == 0 && feof(stdin)) break;
    if (got != sizeof(header)) { fputs("partial token scenario header\n", stderr); return 2; }
    u64 length = read_le(header, 8);
    if (length > (1u << 20)) { fputs("oversized loader input\n", stderr); return 2; }
    tc_pda_error = read_le(header + 8, 8);
    tc_invoke_error = read_le(header + 16, 8);
    memcpy(tc_pda_key, header + 24, 32); tc_pda_bump = header[56];
    u32 id = (u32)read_le(header + 57, 4);
    u8 *input = (u8 *)malloc((size_t)length);
    if (!input) return 4;
    if (fread(input, 1, (size_t)length, stdin) != length) { free(input); return 2; }
    if (tc_run_one(input, (size_t)length, id)) { free(input); return 4; }
    free(input);
  }
  puts("done");
  return 0;
}
