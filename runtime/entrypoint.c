#include "solana_min.h"
#include "escrow.h"

/* Custom errors: 1 account count, 2 instruction, 3 owner, 4 state encoding,
 * 5 writable permission, 6 duplicate accounts, 7 authorization.
 * Account data: BND2 | version:u8 | tag:u8 | reserved:u16 | amount:u64 LE |
 * authority:[u8;32]. This POC changes ledger state, not lamports or SPL tokens.
 */
__attribute__((visibility("default")))
u64 entrypoint(const u8 *input) {
  if (read_le(input, 8) != 2) return 1;
  Account state, authority;
  const u8 *p = read_account(input + 8, &state);
  if (!p) return 6;
  p = read_account(p, &authority);
  if (!p || equal_key(state.key, authority.key)) return 6;
  if (read_le(p, 8) != 1 || p[8] != 0) return 2;
  const u8 *program_id = p + 9;
  if (!equal_key(state.owner, program_id) || state.executable) return 3;
  if (state.size != 48) return 4;
  u8 *d = state.data;
  if (d[0] != 'B' || d[1] != 'N' || d[2] != 'D' || d[3] != '2' ||
      d[4] != 1 || d[5] > 1 || d[6] || d[7]) return 4;
  if (!state.writable) return 5;
  unsigned authorized = authority.signer && equal_key(authority.key, d + 16);
  bend_escrow_2e_Amount_t amount = bend_escrow_2e_Amount_make(
      (u32)read_le(d + 8, 4), (u32)read_le(d + 12, 4));
  bend_escrow_2e_Escrow_t before = d[5] == 0
      ? bend_escrow_2e_Locked_make(amount) : bend_escrow_2e_Released_make(amount);
  bend_escrow_2e_Escrow_t after = bend_escrow_2e_release(authorized, before);
  if (!authorized) return 7;
  bend_escrow_2e_Amount_t result = after.tag == 0 ? after.as.c0.f0 : after.as.c1.f0;
  d[5] = (u8)after.tag;
  write_le(d + 8, result.as.c0.f0, 4);
  write_le(d + 12, result.as.c0.f1, 4);
  u8 reply[9];
  reply[0] = d[5];
  write_le(reply + 1, result.as.c0.f0, 4);
  write_le(reply + 5, result.as.c0.f1, 4);
  sol_set_return_data(reply, sizeof(reply));
  return 0;
}
