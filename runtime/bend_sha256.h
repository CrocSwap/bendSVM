#pragma once

/*
 * Bounded Solana SHA-256 hashv adapter.
 *
 * Preconditions callers cannot prove here: every nonempty slice and the
 * descriptor array name readable bytes for this call; the descriptor array is
 * aligned for BendSha256Slice; and the caller keeps all inputs alive and
 * unchanged until return. Input slices may overlap one another. The 32-byte
 * output must be writable and disjoint from the descriptors and every input
 * byte range. This wrapper never writes to an input range.
 *
 * Pointer validity is a caller/VM mapping precondition. The checks below reject
 * null nonempty slices, integer range wrap, and output aliasing; they cannot
 * establish that an arbitrary non-null address is mapped or readable.
 */

#include "solana_min.h"
#include <stddef.h>
#include <stdint.h>

#define BEND_SHA256_MAX_SLICES 16u
#define BEND_SHA256_MAX_BYTES 1024u
#define BEND_SHA256_DIGEST_BYTES 32u

typedef struct {
  const u8 *data;
  u64 len;
} BendSha256Slice;

_Static_assert(sizeof(void *) == 8, "Solana SHA-256 ABI requires 64-bit pointers");
_Static_assert(sizeof(BendSha256Slice) == 16, "Solana hashv slice ABI is 16 bytes");
_Static_assert(offsetof(BendSha256Slice, data) == 0, "Solana hashv address offset");
_Static_assert(offsetof(BendSha256Slice, len) == 8, "Solana hashv length offset");

typedef enum {
  BEND_SHA256_OK = 0,
  BEND_SHA256_INVALID_ARGUMENT = 1,
  BEND_SHA256_TOO_MANY_SLICES = 2,
  BEND_SHA256_TOO_MANY_BYTES = 3,
  BEND_SHA256_RANGE_OVERFLOW = 4,
  BEND_SHA256_OUTPUT_ALIAS = 5,
  BEND_SHA256_SYSCALL_FAILURE = 6
} BendSha256Status;

typedef struct {
  BendSha256Status status;
  /* Zero except on BEND_SHA256_SYSCALL_FAILURE; then this is the exact
   * nonzero sol_sha256 return value. */
  u64 syscall_status;
} BendSha256Result;

/* Exact Solana SHA-256 syscall ABI. val_len is the number of descriptors. */
extern u64 sol_sha256(const u8 *vals, u64 val_len, u8 *hash_result);

static inline int bend_sha256_ranges_overlap(uintptr_t a, uintptr_t a_end,
                                              uintptr_t b, uintptr_t b_end) {
  return a < b_end && b < a_end;
}

static inline BendSha256Result bend_sha256_result(BendSha256Status status,
                                                   u64 syscall_status) {
  BendSha256Result result = {0};
  result.status = status;
  result.syscall_status = syscall_status;
  return result;
}

/* Hash the concatenation of parts in order, with no framing between parts.
 * Empty slices are valid and count toward the 16-slice limit. Zero slices
 * represent the empty message. On every failure, including a syscall failure
 * after it has written its temporary result, output remains byte-for-byte
 * unchanged. */
static inline BendSha256Result bend_sha256_hashv(
    const BendSha256Slice *parts, u64 part_count,
    u8 output[BEND_SHA256_DIGEST_BYTES]) {
  if (output == NULL) return bend_sha256_result(BEND_SHA256_INVALID_ARGUMENT, 0);
  if (part_count > BEND_SHA256_MAX_SLICES)
    return bend_sha256_result(BEND_SHA256_TOO_MANY_SLICES, 0);
  if (part_count != 0 && parts == NULL)
    return bend_sha256_result(BEND_SHA256_INVALID_ARGUMENT, 0);

  const uintptr_t out_start = (uintptr_t)output;
  if (out_start > UINTPTR_MAX - BEND_SHA256_DIGEST_BYTES)
    return bend_sha256_result(BEND_SHA256_RANGE_OVERFLOW, 0);
  const uintptr_t out_end = out_start + BEND_SHA256_DIGEST_BYTES;

  uintptr_t parts_start = 0;
  uintptr_t parts_end = 0;
  if (part_count != 0) {
    const u64 parts_bytes = part_count * (u64)sizeof(BendSha256Slice);
    parts_start = (uintptr_t)parts;
    if ((parts_start & (_Alignof(BendSha256Slice) - 1u)) != 0)
      return bend_sha256_result(BEND_SHA256_INVALID_ARGUMENT, 0);
    if (parts_start > UINTPTR_MAX - (uintptr_t)parts_bytes)
      return bend_sha256_result(BEND_SHA256_RANGE_OVERFLOW, 0);
    parts_end = parts_start + (uintptr_t)parts_bytes;
    if (bend_sha256_ranges_overlap(out_start, out_end, parts_start, parts_end))
      return bend_sha256_result(BEND_SHA256_OUTPUT_ALIAS, 0);
  }

  u64 total_bytes = 0;
  for (u64 i = 0; i < part_count; ++i) {
    const BendSha256Slice *part = &parts[i];
    if (part->len > BEND_SHA256_MAX_BYTES - total_bytes)
      return bend_sha256_result(BEND_SHA256_TOO_MANY_BYTES, 0);
    total_bytes += part->len;
    if (part->len == 0) continue;
    if (part->data == NULL)
      return bend_sha256_result(BEND_SHA256_INVALID_ARGUMENT, 0);

    const uintptr_t start = (uintptr_t)part->data;
    if (start > UINTPTR_MAX - (uintptr_t)part->len)
      return bend_sha256_result(BEND_SHA256_RANGE_OVERFLOW, 0);
    const uintptr_t end = start + (uintptr_t)part->len;
    if (bend_sha256_ranges_overlap(out_start, out_end, start, end))
      return bend_sha256_result(BEND_SHA256_OUTPUT_ALIAS, 0);
  }

  u8 digest[BEND_SHA256_DIGEST_BYTES];
  const u64 syscall_status = sol_sha256((const u8 *)parts, part_count, digest);
  if (syscall_status != 0)
    return bend_sha256_result(BEND_SHA256_SYSCALL_FAILURE, syscall_status);

  for (u32 i = 0; i < BEND_SHA256_DIGEST_BYTES; ++i) output[i] = digest[i];
  return bend_sha256_result(BEND_SHA256_OK, 0);
}
