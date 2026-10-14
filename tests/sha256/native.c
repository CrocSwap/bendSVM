#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "bend_sha256.h"

static u64 stub_status;
static u64 stub_calls;
static u64 stub_count;
static const BendSha256Slice *stub_parts;
static u8 stub_write_byte;

u64 sol_sha256(const u8 *vals, u64 val_len, u8 *hash_result) {
  stub_calls++;
  stub_count = val_len;
  stub_parts = (const BendSha256Slice *)vals;
  for (u32 i = 0; i < BEND_SHA256_DIGEST_BYTES; ++i)
    hash_result[i] = (u8)(stub_write_byte + i);
  return stub_status;
}

static void expect_status(BendSha256Result result, BendSha256Status expected) {
  assert(result.status == expected);
  if (expected != BEND_SHA256_SYSCALL_FAILURE) assert(result.syscall_status == 0);
}

int main(void) {
  u8 bytes[1024];
  for (u32 i = 0; i < sizeof(bytes); ++i) bytes[i] = (u8)i;
  u8 before[sizeof(bytes)];
  memcpy(before, bytes, sizeof(bytes));
  BendSha256Slice parts[BEND_SHA256_MAX_SLICES];
  for (u32 i = 0; i < BEND_SHA256_MAX_SLICES; ++i) {
    parts[i].data = bytes + i * 64;
    parts[i].len = 64;
  }
  BendSha256Slice parts_before[BEND_SHA256_MAX_SLICES];
  memcpy(parts_before, parts, sizeof(parts));
  u8 output[BEND_SHA256_DIGEST_BYTES];
  memset(output, 0xa5, sizeof(output));
  stub_calls = 0;
  stub_status = 0;
  stub_write_byte = 0x30;
  BendSha256Result result = bend_sha256_hashv(parts, BEND_SHA256_MAX_SLICES, output);
  expect_status(result, BEND_SHA256_OK);
  assert(stub_calls == 1 && stub_count == BEND_SHA256_MAX_SLICES && stub_parts == parts);
  for (u32 i = 0; i < sizeof(output); ++i) assert(output[i] == (u8)(0x30 + i));
  assert(memcmp(before, bytes, sizeof(bytes)) == 0);
  assert(memcmp(parts_before, parts, sizeof(parts)) == 0);

  /* The wrapper stages syscall output; even a failing syscall that wrote its
   * destination cannot alter caller output, and its exact status propagates. */
  memset(output, 0x7c, sizeof(output));
  stub_status = UINT64_C(0x123456789abcdef0);
  stub_write_byte = 0xee;
  result = bend_sha256_hashv(parts, 1, output);
  expect_status(result, BEND_SHA256_SYSCALL_FAILURE);
  assert(result.syscall_status == stub_status);
  for (u32 i = 0; i < sizeof(output); ++i) assert(output[i] == 0x7c);
  assert(memcmp(before, bytes, sizeof(bytes)) == 0);
  assert(memcmp(parts_before, parts, sizeof(parts)) == 0);

  memset(output, 0x91, sizeof(output));
  stub_calls = 0;
  result = bend_sha256_hashv(NULL, 0, output);
  expect_status(result, BEND_SHA256_SYSCALL_FAILURE);
  assert(stub_calls == 1 && stub_count == 0 && stub_parts == NULL);
  for (u32 i = 0; i < sizeof(output); ++i) assert(output[i] == 0x91);

  BendSha256Slice too_many[BEND_SHA256_MAX_SLICES + 1] = {{0}};
  memset(output, 0x42, sizeof(output));
  stub_calls = 0;
  result = bend_sha256_hashv(too_many, BEND_SHA256_MAX_SLICES + 1, output);
  expect_status(result, BEND_SHA256_TOO_MANY_SLICES);
  assert(stub_calls == 0);
  for (u32 i = 0; i < sizeof(output); ++i) assert(output[i] == 0x42);

  parts[0] = (BendSha256Slice){bytes, BEND_SHA256_MAX_BYTES};
  parts[1] = (BendSha256Slice){bytes, 1};
  memset(output, 0x43, sizeof(output));
  result = bend_sha256_hashv(parts, 2, output);
  expect_status(result, BEND_SHA256_TOO_MANY_BYTES);
  assert(stub_calls == 0);
  for (u32 i = 0; i < sizeof(output); ++i) assert(output[i] == 0x43);

  parts[0] = (BendSha256Slice){NULL, 1};
  result = bend_sha256_hashv(parts, 1, output);
  expect_status(result, BEND_SHA256_INVALID_ARGUMENT);
  parts[0] = (BendSha256Slice){(const u8 *)(uintptr_t)(UINTPTR_MAX - 1), 4};
  result = bend_sha256_hashv(parts, 1, output);
  expect_status(result, BEND_SHA256_RANGE_OVERFLOW);

  parts[0] = (BendSha256Slice){bytes, 16};
  result = bend_sha256_hashv(parts, 1, bytes + 8);
  expect_status(result, BEND_SHA256_OUTPUT_ALIAS);
  assert(memcmp(before, bytes, sizeof(bytes)) == 0);

  BendSha256Slice alias_parts[2] = {{bytes, 1}, {bytes + 1, 1}};
  u8 alias_before[sizeof(alias_parts)];
  memcpy(alias_before, alias_parts, sizeof(alias_parts));
  result = bend_sha256_hashv(alias_parts, 1, (u8 *)alias_parts);
  expect_status(result, BEND_SHA256_OUTPUT_ALIAS);
  assert(memcmp(alias_before, alias_parts, sizeof(alias_parts)) == 0);

  union { max_align_t alignment; u8 bytes[sizeof(BendSha256Slice) + 1]; } unaligned;
  memset(unaligned.bytes, 0, sizeof(unaligned.bytes));
  result = bend_sha256_hashv((const BendSha256Slice *)(unaligned.bytes + 1), 1, output);
  expect_status(result, BEND_SHA256_INVALID_ARGUMENT);

  puts("native SHA-256 ABI wrapper checks passed");
  return 0;
}
