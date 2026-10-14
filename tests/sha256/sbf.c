#include "bend_sha256.h"

extern void sol_set_return_data(const u8 *data, u64 length);

/* Instruction data is generic: count:u8, then count repetitions of
 * length:u16-le followed by that many uninterpreted bytes. There are no
 * application or protocol branches in this first-slice executor. */
__attribute__((visibility("default")))
u64 entrypoint(const u8 *input) {
  if (read_le(input, 8) != 0) return 10;
  const u64 instruction_length = read_le(input + 8, 8);
  const u8 *instruction = input + 16;
  if (instruction_length == 0) return 11;

  const u8 count = instruction[0];
  BendSha256Slice parts[BEND_SHA256_MAX_SLICES + 1] = {{0}};
  u8 digest[BEND_SHA256_DIGEST_BYTES];
  if (count > BEND_SHA256_MAX_SLICES) {
    BendSha256Result rejected = bend_sha256_hashv(parts, count, digest);
    return rejected.status == BEND_SHA256_TOO_MANY_SLICES ? 200 + rejected.status : 12;
  }

  u64 cursor = 1;
  for (u64 i = 0; i < count; ++i) {
    if (cursor > instruction_length || instruction_length - cursor < 2) return 13;
    const u64 length = read_le(instruction + cursor, 2);
    cursor += 2;
    if (length > instruction_length - cursor) return 13;
    parts[i].data = instruction + cursor;
    parts[i].len = length;
    cursor += length;
  }
  if (cursor != instruction_length) return 14;

  BendSha256Result result = bend_sha256_hashv(parts, count, digest);
  if (result.status != BEND_SHA256_OK) return 200 + result.status;
  sol_set_return_data(digest, BEND_SHA256_DIGEST_BYTES);
  return 0;
}
