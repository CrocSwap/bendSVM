#pragma once
/* Shared stateless entrypoint for any generated bend_wire_dispatch. Include
 * solana_min.h and the module's .dispatch.h before this file. No accounts are
 * accepted: this interface cannot be used to forge an onchain account context.
 */
u64 entrypoint(const u8 *input) {
  if (read_le(input, 8) != 0) return 1;
  u64 length = read_le(input + 8, 8);
  if (length > 1024) return 2;
  u8 output[1024];
  u64 written;
  if (!bend_wire_dispatch(input + 16, length, output, sizeof(output), &written)) return 2;
  sol_set_return_data(output, written);
  return 0;
}
