#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "token.h"

#pragma pack(push, 1)
typedef struct {
  u32 active, source, destination, mint, authority, recipient;
  u8 mint_key[32], recipient_key[32];
  u64 amount;
  u32 initialize, source_bound, destination_bound, fresh_destination;
  u8 source_key[32], destination_key[32];
} WireTransfer;
typedef struct {
  u8 key[32], owner[32], data[165];
  u64 size, lamports, rent_epoch;
  u32 signer, writable, executable;
} WireAccount;
typedef struct {
  u32 id, operation, count, exact_allocations;
  WireTransfer transfer;
  u8 pda_program[32], pda_key[32];
  u64 pda_error, invoke_error;
  u8 pda_bump, initial_bump;
  WireAccount accounts[12];
} WireInput;
#pragma pack(pop)

_Static_assert(sizeof(WireTransfer) == sizeof(BendTransfer), "transfer wire layout");
_Static_assert(sizeof(WireAccount) == 265, "account wire layout");
_Static_assert(sizeof(WireInput) == 3454, "token input wire layout");

typedef struct { u64 length; u8 bytes[32]; } SeedCapture;
typedef struct {
  u32 index, writable, signer, key_pointer_ok;
  u8 key[32];
} MetaCapture;
typedef struct {
  u8 key[32], owner[32];
  u64 lamports, data_length, rent_epoch;
  u32 signer, writable, executable;
  u32 key_pointer_ok, lamports_pointer_ok, data_pointer_ok, owner_pointer_ok;
} InfoCapture;
typedef struct {
  int raw_info_count, raw_signer_count;
  u64 raw_meta_count;
  u32 info_count, meta_count;
  u32 program_pointer_ok, accounts_pointer_present, data_pointer_present;
  u32 signer_count, signer_seed_count;
  u64 instruction_length, syscall_error;
  u8 program[32], data[10];
  SeedCapture signer_seeds[3];
  MetaCapture metas[4];
  InfoCapture infos[12];
} InvokeCapture;

static const WireInput *g_input;
static Account g_accounts[12];
static u64 g_lamports[12];
static u8 *g_data[12];
static BendTransfer g_transfer;
static u64 g_pda_calls, g_invoke_calls;
static int g_pda_seed_count;
static SeedCapture g_pda_seeds[2];
static u8 g_pda_program[32], g_pda_returned_key[32], g_pda_out_bump;
static u8 g_bump_out;
static InvokeCapture g_call;

static void hex(const u8 *p, size_t n) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < n; ++i) { putchar(digits[p[i] >> 4]); putchar(digits[p[i] & 15]); }
}

u64 sol_try_find_program_address(const BendSeed *seeds, int count, const u8 *program, u8 *key, u8 *bump) {
  ++g_pda_calls;
  g_pda_seed_count = count;
  memset(g_pda_seeds, 0, sizeof(g_pda_seeds));
  for (int i = 0; i < count && i < 2; ++i) {
    g_pda_seeds[i].length = seeds[i].length;
    if (seeds[i].address && seeds[i].length <= sizeof(g_pda_seeds[i].bytes))
      memcpy(g_pda_seeds[i].bytes, seeds[i].address, (size_t)seeds[i].length);
  }
  if (program) memcpy(g_pda_program, program, 32); else memset(g_pda_program, 0, 32);
  if (g_input->pda_error == 0) {
    memcpy(key, g_input->pda_key, 32);
    *bump = g_input->pda_bump;
    memcpy(g_pda_returned_key, g_input->pda_key, 32);
    g_pda_out_bump = g_input->pda_bump;
  }
  return g_input->pda_error;
}

u64 sol_invoke_signed_c(const BendInstruction *ix, const BendAccountInfo *infos, int count,
                        const BendSeeds *signer_seeds, int signer_count) {
  ++g_invoke_calls;
  InvokeCapture *c = &g_call;
  memset(c, 0, sizeof(*c));
  /* Record raw counts before bounded inspection of the helper's local arrays. */
  c->raw_info_count = count;
  c->raw_meta_count = ix->count;
  c->raw_signer_count = signer_count;
  c->info_count = count < 0 ? 0u : (u32)count;
  if (c->info_count > 12) c->info_count = 12;
  if (c->info_count > g_input->count) c->info_count = g_input->count;
  c->meta_count = ix->count > 4 ? 4u : (u32)ix->count;
  u32 expected_metas = g_input->transfer.active == 1 ? 4 : 3;
  if (c->meta_count > expected_metas) c->meta_count = expected_metas;
  c->program_pointer_ok = ix->program == g_accounts[2].key;
  c->accounts_pointer_present = ix->accounts != NULL;
  c->data_pointer_present = ix->data != NULL;
  c->signer_count = signer_count < 0 ? 0u : (u32)signer_count;
  c->signer_seed_count = signer_seeds && signer_seeds->count <= 3 ? (u32)signer_seeds->count : 0;
  for (u32 i = 0; i < c->signer_seed_count; ++i) {
    c->signer_seeds[i].length = signer_seeds->seeds[i].length;
    if (signer_seeds->seeds[i].address && signer_seeds->seeds[i].length <= sizeof(c->signer_seeds[i].bytes))
      memcpy(c->signer_seeds[i].bytes, signer_seeds->seeds[i].address, (size_t)signer_seeds->seeds[i].length);
  }
  c->instruction_length = ix->length;
  c->syscall_error = g_input->invoke_error;
  if (ix->program) memcpy(c->program, ix->program, 32);
  if (ix->data && ix->length <= sizeof(c->data)) memcpy(c->data, ix->data, (size_t)ix->length);
  for (u32 i = 0; i < c->meta_count; ++i) {
    const BendAccountMeta *m = &ix->accounts[i];
    MetaCapture *d = &c->metas[i];
    d->index = 0xffffffffu;
    for (u32 j = 0; j < 12; ++j) if (m->key == g_accounts[j].key) {
      d->index = j; d->key_pointer_ok = 1; break;
    }
    if (m->key) memcpy(d->key, m->key, 32);
    d->writable = m->writable; d->signer = m->signer;
  }
  for (u32 i = 0; i < c->info_count; ++i) {
    const BendAccountInfo *a = &infos[i];
    InfoCapture *d = &c->infos[i];
    memcpy(d->key, a->key, 32); memcpy(d->owner, a->owner, 32);
    d->lamports = *a->lamports; d->data_length = a->data_len; d->rent_epoch = a->rent_epoch;
    d->signer = a->signer; d->writable = a->writable; d->executable = a->executable;
    d->key_pointer_ok = a->key == g_accounts[i].key;
    d->lamports_pointer_ok = a->lamports == g_accounts[i].lamports;
    d->data_pointer_ok = a->data == g_accounts[i].data;
    d->owner_pointer_ok = a->owner == g_accounts[i].owner;
  }
  return g_input->invoke_error;
}

static void setup(const WireInput *in) {
  g_input = in;
  g_pda_calls = g_invoke_calls = 0;
  g_pda_seed_count = 0; g_bump_out = in->initial_bump; g_pda_out_bump = 0;
  memset(g_pda_seeds, 0, sizeof(g_pda_seeds)); memset(g_pda_program, 0, 32);
  memset(g_pda_returned_key, 0, 32); memset(&g_call, 0, sizeof(g_call));
  memcpy(&g_transfer, &in->transfer, sizeof(g_transfer));
  for (u32 i = 0; i < 12; ++i) {
    const WireAccount *w = &in->accounts[i];
    size_t n = in->exact_allocations ? (size_t)w->size : sizeof(w->data);
    if (n > sizeof(w->data)) n = sizeof(w->data);
    g_data[i] = (u8 *)malloc(n);
    if (!g_data[i] && n) { fputs("account allocation failed\n", stderr); exit(4); }
    if (n) memcpy(g_data[i], w->data, n);
    g_lamports[i] = w->lamports;
    g_accounts[i] = (Account){w->key, w->owner, g_data[i], w->size, &g_lamports[i], w->rent_epoch,
      w->signer, w->writable, w->executable};
  }
}

static void free_accounts(void) {
  for (u32 i = 0; i < 12; ++i) { free(g_data[i]); g_data[i] = NULL; }
}

static void print_pda(void) {
  printf("{\"program\":\""); hex(g_pda_program, 32); printf("\",\"seedCount\":%d,\"seeds\":[", g_pda_seed_count);
  for (int i = 0; i < g_pda_seed_count && i < 2; ++i) {
    if (i) putchar(',');
    printf("{\"length\":\"%llu\",\"data\":\"", g_pda_seeds[i].length);
    size_t n = g_pda_seeds[i].length <= sizeof(g_pda_seeds[i].bytes) ? (size_t)g_pda_seeds[i].length : 0;
    hex(g_pda_seeds[i].bytes, n); printf("\"}");
  }
  printf("],\"returnedKey\":\""); hex(g_pda_returned_key, 32);
  printf("\",\"returnedBump\":%u,\"outBump\":%u}", g_pda_out_bump, g_bump_out);
}

static void print_call(const InvokeCapture *c) {
  printf("{\"rawInfoCount\":%d,\"rawMetaCount\":\"%llu\",\"rawSignerCount\":%d,\"infoCount\":%u,\"metaCount\":%u,\"programPointerOk\":%u,\"accountsPointerPresent\":%u,\"dataPointerPresent\":%u,\"signerCount\":%u,\"signerSeedCount\":%u,\"signerSeeds\":[",
    c->raw_info_count, c->raw_meta_count, c->raw_signer_count, c->info_count, c->meta_count, c->program_pointer_ok,
    c->accounts_pointer_present, c->data_pointer_present, c->signer_count, c->signer_seed_count);
  for (u32 i = 0; i < c->signer_seed_count; ++i) {
    if (i) putchar(',');
    printf("{\"length\":\"%llu\",\"data\":\"", c->signer_seeds[i].length);
    size_t n = c->signer_seeds[i].length <= sizeof(c->signer_seeds[i].bytes) ? (size_t)c->signer_seeds[i].length : 0;
    hex(c->signer_seeds[i].bytes, n); printf("\"}");
  }
  printf("],\"instructionLength\":\"%llu\",\"syscallError\":\"%llu\",\"program\":\"", c->instruction_length, c->syscall_error);
  hex(c->program, 32); printf("\",\"data\":\""); hex(c->data, sizeof(c->data)); printf("\",\"metas\":[");
  for (u32 i = 0; i < c->meta_count; ++i) {
    const MetaCapture *m = &c->metas[i]; if (i) putchar(',');
    printf("{\"index\":%u,\"writable\":%u,\"signer\":%u,\"keyPointerOk\":%u,\"key\":\"",
      m->index, m->writable, m->signer, m->key_pointer_ok); hex(m->key, 32); printf("\"}");
  }
  printf("],\"infos\":[");
  for (u32 i = 0; i < c->info_count; ++i) {
    const InfoCapture *a = &c->infos[i]; if (i) putchar(',');
    printf("{\"key\":\""); hex(a->key, 32); printf("\",\"owner\":\""); hex(a->owner, 32);
    printf("\",\"lamports\":\"%llu\",\"dataLength\":\"%llu\",\"rentEpoch\":\"%llu\",\"signer\":%u,\"writable\":%u,\"executable\":%u,\"keyPointerOk\":%u,\"lamportsPointerOk\":%u,\"dataPointerOk\":%u,\"ownerPointerOk\":%u}",
      a->lamports, a->data_length, a->rent_epoch, a->signer, a->writable, a->executable,
      a->key_pointer_ok, a->lamports_pointer_ok, a->data_pointer_ok, a->owner_pointer_ok);
  }
  printf("]}");
}

static void print_accounts(const WireInput *in) {
  printf("[");
  for (u32 i = 0; i < 12; ++i) {
    const WireAccount *w = &in->accounts[i];
    size_t n = in->exact_allocations ? (size_t)w->size : sizeof(w->data);
    if (n > sizeof(w->data)) n = sizeof(w->data);
    if (i) putchar(',');
    const Account *a = &g_accounts[i];
    printf("{\"key\":\""); hex(a->key, 32); printf("\",\"owner\":\""); hex(a->owner, 32);
    printf("\",\"size\":\"%llu\",\"lamports\":\"%llu\",\"rentEpoch\":\"%llu\",\"signer\":%u,\"writable\":%u,\"executable\":%u,\"keyPointerUnchanged\":%u,\"ownerPointerUnchanged\":%u,\"dataPointerUnchanged\":%u,\"lamportsPointerUnchanged\":%u,\"data\":\"",
      a->size, *a->lamports, a->rent_epoch, a->signer, a->writable, a->executable,
      a->key == w->key, a->owner == w->owner, a->data == g_data[i], a->lamports == &g_lamports[i]);
    hex(g_data[i], n); printf("\"}");
  }
  printf("]");
}

static int run_one(const WireInput *in) {
  setup(in);
  u64 result = 0, validation = 0, custody_result = 0;
  u8 bump = in->initial_bump;
  if (in->operation == 1) result = bend_token_program(&g_accounts[2]) ? 0 : 10;
  else if (in->operation == 2) {
    custody_result = bend_custody(g_accounts, in->pda_program, &bump); g_bump_out = bump; result = custody_result;
  }
  else if (in->operation == 3) result = bend_transfer_validate(&g_transfer, g_accounts, in->count);
  else if (in->operation == 4) {
    custody_result = bend_custody(g_accounts, in->pda_program, &bump); g_bump_out = bump;
    if (custody_result == 0) {
      validation = bend_transfer_validate(&g_transfer, g_accounts, in->count);
      if (validation == 0) result = bend_transfer_execute(&g_transfer, g_accounts, in->count, bump);
      else result = validation;
    } else result = custody_result;
  } else { free_accounts(); return 2; }

  printf("{\"id\":%u,\"result\":\"%llu\",\"validation\":\"%llu\",\"custodyResult\":\"%llu\",\"pdaCalls\":\"%llu\",\"invokeCalls\":\"%llu\",\"bump\":%u,\"pda\":",
    in->id, result, validation, custody_result, g_pda_calls, g_invoke_calls, g_bump_out);
  if (g_pda_calls) print_pda(); else printf("null");
  printf(",\"call\":"); if (g_invoke_calls) print_call(&g_call); else printf("null");
  printf(",\"effectUnchanged\":%u", memcmp(&g_transfer, &in->transfer, sizeof(g_transfer)) == 0);
  printf(",\"accounts\":"); print_accounts(in); printf("}\n");
  free_accounts();
  return 0;
}

int main(void) {
  WireInput in;
  while (1) {
    size_t n = fread(&in, 1, sizeof(in), stdin);
    if (n == 0 && feof(stdin)) break;
    if (n != sizeof(in)) { fputs("partial input record\n", stderr); return 2; }
    if (run_one(&in)) { fputs("invalid harness operation\n", stderr); return 3; }
  }
  return 0;
}
