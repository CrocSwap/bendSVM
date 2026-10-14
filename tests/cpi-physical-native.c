/* Direct actual-helper checks. The syscall double supplies resize metadata;
 * these finite host checks do not establish Solana permissions or rollback. */
#include "bend_cpi.h"
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

_Static_assert(sizeof(Account) == 64, "Account stride");
_Static_assert(offsetof(Account, size) == 24, "Account size offset");
_Static_assert(offsetof(BendAccountInfo, data_len) == 16, "info length offset");
_Static_assert(sizeof(BendInvoke) == 464, "pending effect stride");

static unsigned expected_count, external, calls, fail_call;
static u64 resize_to;
static Account *caller_accounts;
static u8 pending_reply[1024], pending_header[52];
static BendInvoke pending_effects[2];

static int fail(unsigned code, const char *message) {
  fprintf(stderr, "%s\n", message);
  return (int)code;
}

u64 sol_invoke_signed_c(const BendInstruction *ix, const BendAccountInfo *infos,
                       int count, const BendSeeds *signer, int custody) {
  calls++;
  if ((unsigned)count != expected_count || ix->count != 1 || ix->length != 1 ||
      ix->data[0] != (calls == 1 ? 42 : 99) || custody || signer->count != 3 ||
      ix->accounts[0].key != caller_accounts[external].key ||
      !ix->accounts[0].writable || ix->accounts[0].signer)
    return 90;
  for (unsigned i = 0; i < (unsigned)count; ++i) {
    const Account *a = &caller_accounts[i];
    if (infos[i].key != a->key || infos[i].data != a->data ||
        infos[i].owner != a->owner || infos[i].lamports != a->lamports ||
        infos[i].data_len != read_le(a->data - 8, 8))
      return 91; /* A later call must observe the refreshed length. */
    uintptr_t pointers[] = {(uintptr_t)infos[i].key, (uintptr_t)infos[i].data,
                            (uintptr_t)infos[i].owner, (uintptr_t)infos[i].lamports};
    for (unsigned j = 0; j < 4; ++j) {
      const u8 *objects[] = {pending_reply, pending_header, (const u8 *)pending_effects};
      const size_t sizes[] = {sizeof pending_reply, sizeof pending_header, sizeof pending_effects};
      for (unsigned k = 0; k < 3; ++k)
        if (pointers[j] >= (uintptr_t)objects[k] && pointers[j] < (uintptr_t)objects[k] + sizes[k])
          return 92;
    }
  }
  BendAccountInfo *updated = (BendAccountInfo *)infos;
  updated[external].data_len = resize_to;
  write_le(caller_accounts[external].data - 8, resize_to, 8);
  caller_accounts[external].data[0] ^= 0x51;
  return calls == fail_call ? (1ULL << 63) : 0;
}

int main(void) {
  for (unsigned count_case = 0; count_case < 2; ++count_case)
  for (unsigned resize_case = 0; resize_case < 3; ++resize_case)
  for (unsigned result_case = 0; result_case < 4; ++result_case) {
    /* 24 scenarios: two counts, grow/shrink/same, success/first error/
     * second error/inactive. Aligned loader buffers have real realloc space. */
    _Alignas(8) u8 serialized[12][88 + 128 + 10240 + 8] = {{0}};
    Account accounts[12] = {{0}}, before[12];
    expected_count = count_case ? 12 : 4;
    external = expected_count - 1;
    resize_to = resize_case == 0 ? 192 : resize_case == 1 ? 32 : 128;
    fail_call = result_case == 1 ? 1 : result_case == 2 ? 2 : 0;
    calls = 0;
    for (unsigned i = 0; i < 12; ++i) {
      serialized[i][0] = 255;
      serialized[i][1] = serialized[i][2] = 1;
      serialized[i][3] = i == 2;
      serialized[i][8] = (u8)(i + 1);
      write_le(serialized[i] + 80, 128, 8);
      if (!read_account(serialized[i], &accounts[i])) return fail(40, "loader rejected valid buffer");
    }
    memcpy(before, accounts, sizeof accounts);
    caller_accounts = accounts;
    memset(pending_reply, 0x34, sizeof pending_reply);
    memset(pending_header, 0x56, sizeof pending_header);
    memset(pending_effects, 0, sizeof pending_effects);
    for (unsigned slot = 0; slot < 2; ++slot) {
      BendInvoke *effect = &pending_effects[slot];
      effect->active = result_case != 3;
      effect->program = 2; effect->length = effect->count = 1;
      memcpy(effect->program_key, accounts[2].key, 32);
      effect->data[0] = slot ? 99 : 42;
      effect->metas[0].index = external; effect->metas[0].writable = 1;
      memcpy(effect->metas[0].key, accounts[external].key, 32);
    }
    u8 effects_before[sizeof pending_effects];
    memcpy(effects_before, pending_effects, sizeof effects_before);
    for (unsigned slot = 0; slot < 2; ++slot) {
      if (bend_invoke_validate(&pending_effects[slot], accounts, expected_count))
        return fail(41, "valid pending effect rejected");
      u64 result = bend_invoke_execute(&pending_effects[slot], accounts, expected_count, 217);
      if (result == 91) return fail(42, "later call stale account length");
      if (result == 92) return fail(43, "pending local exposed through CPI pointer");
      u64 expected = result_case != 3 && calls == fail_call ? (1ULL << 63) : 0;
      if (result != expected) return fail(44, "helper result differs");
      for (unsigned i = 0; i < 12; ++i) {
        Account preserved = accounts[i];
        preserved.size = before[i].size;
        if (memcmp(&preserved, &before[i], sizeof(Account)))
          return fail(46, "descriptor pointer or privilege changed");
        u64 expected_size = before[i].size;
        if (i == external && result_case != 3 && !(fail_call == 1)) expected_size = resize_to;
        if (accounts[i].size != expected_size) return fail(45, "descriptor length refresh differs");
      }
      if (memcmp(effects_before, pending_effects, sizeof effects_before))
        return fail(47, "pending effect bytes changed");
      for (unsigned i = 0; i < sizeof pending_reply; ++i)
        if (pending_reply[i] != 0x34) return fail(48, "pending reply changed");
      for (unsigned i = 0; i < sizeof pending_header; ++i)
        if (pending_header[i] != 0x56) return fail(49, "pending header changed");
      if (result) break;
    }
    if (calls != (result_case == 3 ? 0 : fail_call == 1 ? 1 : 2))
      return fail(50, "inactive or error call count differs");
  }
  return 0;
}
