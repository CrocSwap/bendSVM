#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <sanitizer/asan_interface.h>
#include "bend_cpi.h"

#pragma pack(push, 1)
typedef struct { u32 index, writable, signer; u8 key[32]; } WireMeta;
typedef struct {
  u8 key[32], owner[32], data[80];
  u64 lamports, size, rent_epoch;
  u32 signer, writable, executable;
} WireAccount;
typedef struct {
  u32 id, mode, count, active, program, length, meta_count, rounds;
  u8 initial_bump;
  u8 pad0[3];
  u64 pda_error;
  u8 pda_key[32];
  u8 pda_bump;
  u8 pad1[7];
  u8 pda_program[32];
  u64 invoke_error[2];
  u32 resize_mask[2];
  u64 resize_length[2][12];
  u8 program_key[32], data[64];
  WireMeta metas[8];
  WireAccount accounts[12];
} WireInput;
#pragma pack(pop)

_Static_assert(sizeof(WireMeta) == 44, "wire meta layout");
_Static_assert(sizeof(WireAccount) == 180, "wire account layout");
_Static_assert(sizeof(WireInput) == 2940, "wire input layout");
_Static_assert(sizeof(BendInvoke) == 464, "BendInvoke has no padding");

typedef struct {
  u64 length;
  u8 bytes[80];
} SeedCapture;
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
  u32 program_pointer_ok, accounts_pointer_present, data_pointer_ok;
  u32 signer_count, signer_seed_count;
  u64 instruction_length, syscall_error;
  u8 program[32], data[64];
  SeedCapture signer_seeds[3];
  MetaCapture metas[8];
  InfoCapture infos[12];
  u64 sizes_after[12];
} InvokeCapture;

static const WireInput *g_input;
static Account g_accounts[13];
static u64 g_lamports[13];
static u8 g_keys[13][32], g_owners[13][32], g_data[13][80];
static BendInvoke g_effect;
static u64 g_pda_calls, g_invoke_calls;
static u32 g_seed_count;
static SeedCapture g_seeds[3];
static u8 g_pda_program[32], g_returned_key[32], g_returned_bump;
static u8 g_out_bump;
static InvokeCapture g_calls[2];
static unsigned g_round;

static void hex(const u8 *p, size_t n) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < n; ++i) { putchar(digits[p[i] >> 4]); putchar(digits[p[i] & 15]); }
}

u64 sol_try_find_program_address(const BendSeed *seeds, int count, const u8 *program, u8 *key, u8 *bump) {
  ++g_pda_calls;
  g_seed_count = count < 0 ? 0u : (u32)count;
  if (g_seed_count > 3) g_seed_count = 3;
  memset(g_seeds, 0, sizeof(g_seeds));
  for (u32 i = 0; i < g_seed_count; ++i) {
    g_seeds[i].length = seeds[i].length;
    if (seeds[i].address && seeds[i].length <= sizeof(g_seeds[i].bytes))
      memcpy(g_seeds[i].bytes, seeds[i].address, (size_t)seeds[i].length);
  }
  if (program) memcpy(g_pda_program, program, 32); else memset(g_pda_program, 0, 32);
  memcpy(g_returned_key, g_input->pda_key, 32);
  g_returned_bump = g_input->pda_bump;
  memcpy(key, g_input->pda_key, 32);
  *bump = g_input->pda_bump;
  return g_input->pda_error;
}

u64 sol_invoke_signed_c(const BendInstruction *ix, const BendAccountInfo *infos, int count,
                        const BendSeeds *signer_seeds, int signer_count) {
  ++g_invoke_calls;
  InvokeCapture *c = &g_calls[g_round];
  memset(c, 0, sizeof(*c));
  /* Preserve raw arguments before bounding mock inspection of stack arrays. */
  c->raw_info_count = count;
  c->raw_meta_count = ix->count;
  c->raw_signer_count = signer_count;
  c->info_count = count < 0 ? 0u : (u32)count;
  if (c->info_count > 12) c->info_count = 12;
  c->meta_count = ix->count > 8 ? 8u : (u32)ix->count;
  c->program_pointer_ok = ix->program == g_accounts[g_effect.program].key;
  c->accounts_pointer_present = ix->accounts != NULL;
  c->data_pointer_ok = ix->data == g_effect.data;
  c->signer_count = signer_count < 0 ? 0u : (u32)signer_count;
  c->signer_seed_count = signer_seeds && signer_seeds->count <= 3 ? (u32)signer_seeds->count : 0;
  for (u32 i = 0; i < c->signer_seed_count; ++i) {
    c->signer_seeds[i].length = signer_seeds->seeds[i].length;
    if (signer_seeds->seeds[i].address && signer_seeds->seeds[i].length <= sizeof(c->signer_seeds[i].bytes))
      memcpy(c->signer_seeds[i].bytes, signer_seeds->seeds[i].address, (size_t)signer_seeds->seeds[i].length);
  }
  c->instruction_length = ix->length;
  c->syscall_error = g_input->invoke_error[g_round];
  memcpy(c->program, ix->program, 32);
  memcpy(c->data, ix->data, 64);
  for (u32 i = 0; i < c->meta_count; ++i) {
    const BendAccountMeta *m = &ix->accounts[i];
    MetaCapture *d = &c->metas[i];
    d->index = 0xffffffffu;
    d->key_pointer_ok = 0;
    for (u32 j = 0; j < 12; ++j) if (m->key == g_accounts[j].key) {
      d->index = j; d->key_pointer_ok = 1; break;
    }
    memcpy(d->key, m->key, 32);
    d->writable = m->writable;
    d->signer = m->signer;
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
    if (g_input->resize_mask[g_round] & (1u << i))
      ((BendAccountInfo *)a)->data_len = g_input->resize_length[g_round][i];
    c->sizes_after[i] = ((BendAccountInfo *)a)->data_len;
  }
  (void)signer_count;
  return g_input->invoke_error[g_round];
}

static void setup(const WireInput *in) {
  g_input = in; g_pda_calls = g_invoke_calls = 0; g_seed_count = 0;
  memset(g_seeds, 0, sizeof(g_seeds)); memset(g_calls, 0, sizeof(g_calls));
  memset(g_pda_program, 0, 32); memset(g_returned_key, 0, 32); g_returned_bump = g_out_bump = 0;
  for (u32 i = 0; i < 12; ++i) {
    memcpy(g_keys[i], in->accounts[i].key, 32); memcpy(g_owners[i], in->accounts[i].owner, 32);
    memcpy(g_data[i], in->accounts[i].data, 80); g_lamports[i] = in->accounts[i].lamports;
    g_accounts[i] = (Account){g_keys[i], g_owners[i], g_data[i], in->accounts[i].size,
      &g_lamports[i], in->accounts[i].rent_epoch, in->accounts[i].signer,
      in->accounts[i].writable, in->accounts[i].executable};
  }
  /* Guard account for deliberately weakened index-equality mutations. */
  memset(g_keys[12], 0x5c, 32); memset(g_owners[12], 0x6d, 32); memset(g_data[12], 0x7e, 80);
  g_lamports[12] = 12345;
  g_accounts[12] = (Account){g_keys[12], g_owners[12], g_data[12], 17, &g_lamports[12], 999, 0, 1, 1};
  g_effect.active = in->active; g_effect.program = in->program; g_effect.length = in->length; g_effect.count = in->meta_count;
  memcpy(g_effect.program_key, in->program_key, 32); memcpy(g_effect.data, in->data, 64);
  memcpy(g_effect.metas, in->metas, sizeof(in->metas));
}

static void print_pda(void) {
  printf("{\"program\":\""); hex(g_pda_program, 32); printf("\",\"seedCount\":%u,\"seeds\":[", g_seed_count);
  for (u32 i = 0; i < g_seed_count; ++i) {
    if (i) putchar(',');
    printf("{\"length\":\"%llu\",\"data\":\"", g_seeds[i].length);
    size_t n = g_seeds[i].length <= 80 ? (size_t)g_seeds[i].length : 0;
    hex(g_seeds[i].bytes, n); printf("\"}");
  }
  printf("],\"returnedKey\":\""); hex(g_returned_key, 32);
  printf("\",\"returnedBump\":%u,\"outBump\":%u}", g_returned_bump, g_out_bump);
}

static void print_call(const InvokeCapture *c) {
  printf("{\"rawInfoCount\":%d,\"rawMetaCount\":\"%llu\",\"rawSignerCount\":%d,\"infoCount\":%u,\"metaCount\":%u,\"programPointerOk\":%u,\"accountsPointerPresent\":%u,\"dataPointerOk\":%u,\"signerCount\":%u,\"signerSeedCount\":%u,\"signerSeeds\":[",
    c->raw_info_count, c->raw_meta_count, c->raw_signer_count, c->info_count, c->meta_count, c->program_pointer_ok, c->accounts_pointer_present, c->data_pointer_ok, c->signer_count, c->signer_seed_count);
  for (u32 i = 0; i < c->signer_seed_count; ++i) {
    if (i) putchar(','); printf("{\"length\":\"%llu\",\"data\":\"", c->signer_seeds[i].length);
    size_t n = c->signer_seeds[i].length <= 80 ? (size_t)c->signer_seeds[i].length : 0;
    hex(c->signer_seeds[i].bytes, n); printf("\"}");
  }
  printf("],");
  printf("\"instructionLength\":\"%llu\",\"syscallError\":\"%llu\",\"program\":\"", c->instruction_length, c->syscall_error);
  hex(c->program, 32); printf("\",\"data\":\""); hex(c->data, 64); printf("\",\"metas\":[");
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
  printf("],\"sizesAfterSyscall\":[");
  for (u32 i = 0; i < c->info_count; ++i) { if (i) putchar(','); printf("\"%llu\"", c->sizes_after[i]); }
  printf("]}");
}

static void print_effect(void) {
  printf("{\"active\":%u,\"program\":%u,\"length\":%u,\"count\":%u,\"programKey\":\"", g_effect.active, g_effect.program, g_effect.length, g_effect.count);
  hex(g_effect.program_key, 32); printf("\",\"data\":\""); hex(g_effect.data, 64); printf("\",\"metas\":[");
  for (u32 i = 0; i < 8; ++i) {
    if (i) putchar(','); const BendInvokeMeta *m = &g_effect.metas[i];
    printf("{\"index\":%u,\"writable\":%u,\"signer\":%u,\"key\":\"", m->index, m->writable, m->signer);
    hex(m->key, 32); printf("\"}");
  }
  printf("]}");
}

static void print_accounts(u32 count) {
  (void)count;
  printf("[");
  for (u32 i = 0; i < 12; ++i) {
    const Account *a = &g_accounts[i]; if (i) putchar(',');
    printf("{\"key\":\""); hex(a->key, 32); printf("\",\"owner\":\""); hex(a->owner, 32);
    printf("\",\"data\":\""); hex(a->data, 80);
    printf("\",\"lamports\":\"%llu\",\"size\":\"%llu\",\"rentEpoch\":\"%llu\",\"signer\":%u,\"writable\":%u,\"executable\":%u}",
      *a->lamports, a->size, a->rent_epoch, a->signer, a->writable, a->executable);
  }
  printf("]");
}

static int run_one(const WireInput *in) {
  setup(in);
  u64 pre_custody = 0, pre_validate = 0, result[2] = {0, 0};
  u8 bump = in->initial_bump;
  if (in->mode == 1) {
    pre_custody = bend_invoke_custody(g_accounts, in->pda_program, &bump);
    g_out_bump = bump;
    result[0] = pre_custody;
  } else if (in->mode == 2) {
    for (u32 i = 0; i < in->count; ++i) __asan_poison_memory_region(g_data[i], sizeof(g_data[i]));
    result[0] = bend_invoke_validate(&g_effect, g_accounts, in->count);
    for (u32 i = 0; i < in->count; ++i) __asan_unpoison_memory_region(g_data[i], sizeof(g_data[i]));
  } else if (in->mode == 3) {
    if (g_effect.active) {
      pre_custody = bend_invoke_custody(g_accounts, in->pda_program, &bump);
      g_out_bump = bump;
      pre_validate = bend_invoke_validate(&g_effect, g_accounts, in->count);
      /* The independent input generator admits only baseline-valid effects.
       * A deliberately mutated prerequisite may report its changed result;
       * still finish the matrix so it is a semantic mismatch, not a partial run. */
    }
    for (u32 i = 0; i < in->rounds && i < 2; ++i) {
      g_round = i;
      result[i] = bend_invoke_execute(&g_effect, g_accounts, in->count, bump);
    }
  } else return 2;

  printf("{\"id\":%u,\"preCustody\":\"%llu\",\"preValidate\":\"%llu\",\"result0\":\"%llu\",\"result1\":\"%llu\",\"pdaCalls\":\"%llu\",\"invokeCalls\":\"%llu\",\"pda\":",
    in->id, pre_custody, pre_validate, result[0], result[1], g_pda_calls, g_invoke_calls);
  if (g_pda_calls) print_pda(); else printf("null");
  printf(",\"calls\":[");
  for (u32 i = 0; i < g_invoke_calls; ++i) { if (i) putchar(','); print_call(&g_calls[i]); }
  printf("],\"effect\":"); print_effect(); printf(",\"accounts\":"); print_accounts(in->count); printf("}\n");
  return 0;
}

int main(void) {
  WireInput in;
  while (1) {
    size_t n = fread(&in, 1, sizeof(in), stdin);
    if (n == 0 && feof(stdin)) break;
    if (n != sizeof(in)) { fputs("partial input record\n", stderr); return 2; }
    if (run_one(&in)) { fputs("invalid harness precondition\n", stderr); return 3; }
  }
  return 0;
}
