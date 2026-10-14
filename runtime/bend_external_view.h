#ifndef BEND_EXTERNAL_VIEW_H
#define BEND_EXTERNAL_VIEW_H

#include <stddef.h>
#include <stdint.h>

/* Freestanding SBF does not ship libc headers; the project runtime provides it. */
extern void *memset(void *destination, int value, size_t length);

#define BEND_EXTERNAL_MAX_ACCOUNT_BYTES ((size_t)(10u * 1024u * 1024u))

static inline uint16_t bend_external_load_u16(const uint8_t *p, int big_endian) {
  if (big_endian) return (uint16_t)(((uint16_t)p[0] << 8) | (uint16_t)p[1]);
  return (uint16_t)(((uint16_t)p[1] << 8) | (uint16_t)p[0]);
}

static inline uint32_t bend_external_load_u32(const uint8_t *p, int big_endian) {
  uint32_t value = 0;
  if (big_endian) {
    for (size_t i = 0; i < 4; i++) value = (value << 8) | (uint32_t)p[i];
  } else {
    for (size_t i = 4; i > 0; i--) value = (value << 8) | (uint32_t)p[i - 1];
  }
  return value;
}

static inline uint64_t bend_external_load_u64(const uint8_t *p, int big_endian) {
  uint64_t value = 0;
  if (big_endian) {
    for (size_t i = 0; i < 8; i++) value = (value << 8) | (uint64_t)p[i];
  } else {
    for (size_t i = 8; i > 0; i--) value = (value << 8) | (uint64_t)p[i - 1];
  }
  return value;
}

static inline int bend_external_checked_add_u64(uint64_t left, uint64_t right, uint64_t *out) {
  if (out == NULL || right > UINT64_MAX - left) return 0;
  *out = left + right;
  return 1;
}

static inline int bend_external_checked_multiply_u64(uint64_t left, uint64_t right, uint64_t *out) {
  if (out == NULL || (left != 0 && right > UINT64_MAX / left)) return 0;
  *out = left * right;
  return 1;
}

static inline int bend_external_checked_ceil_divide_u64(uint64_t value, uint64_t divisor, uint64_t *out) {
  if (out == NULL || divisor == 0) return 0;
  uint64_t quotient = value / divisor;
  if (value % divisor != 0) {
    if (quotient == UINT64_MAX) return 0;
    quotient++;
  }
  *out = quotient;
  return 1;
}

static inline int bend_external_buffers_disjoint(
    const uint8_t *input,
    size_t input_length,
    const void *output,
    size_t output_length) {
  if (input == NULL || output == NULL) return 0;
  uintptr_t input_start = (uintptr_t)input;
  uintptr_t output_start = (uintptr_t)output;
  if ((uintmax_t)input_length > (uintmax_t)UINTPTR_MAX || (uintmax_t)output_length > (uintmax_t)UINTPTR_MAX) return 0;
  uintptr_t input_size = (uintptr_t)input_length;
  uintptr_t output_size = (uintptr_t)output_length;
  if (input_size > UINTPTR_MAX - input_start || output_size > UINTPTR_MAX - output_start) return 0;
  uintptr_t input_end = input_start + input_size;
  uintptr_t output_end = output_start + output_size;
  return input_end <= output_start || output_end <= input_start;
}

static inline int bend_external_bytes_equal(const uint8_t *actual, const uint8_t *expected, size_t length) {
  if ((actual == NULL || expected == NULL) && length != 0) return 0;
  for (size_t i = 0; i < length; i++) if (actual[i] != expected[i]) return 0;
  return 1;
}

static inline int bend_external_bytes_all_zero(const uint8_t *actual, size_t length) {
  if (actual == NULL && length != 0) return 0;
  for (size_t i = 0; i < length; i++) if (actual[i] != 0) return 0;
  return 1;
}

/* Bounds a logical window separately from the bytes currently accessible. */
static inline int bend_external_checked_window(
    size_t logical_size,
    size_t accessible_size,
    uint64_t offset,
    uint64_t length,
    uint64_t minimum_offset,
    uint64_t maximum_length,
    int allow_prefix,
    size_t *safe_offset,
    size_t *accessible_offset,
    size_t *accessible_length) {
  if (safe_offset == NULL || accessible_offset == NULL || accessible_length == NULL) return 0;
  if (offset < minimum_offset || length > maximum_length) return 0;
  if (logical_size > BEND_EXTERNAL_MAX_ACCOUNT_BYTES || accessible_size > logical_size) return 0;
  if (offset > (uint64_t)logical_size || length > (uint64_t)logical_size - offset) return 0;
  if (!allow_prefix && (offset > (uint64_t)accessible_size || length > (uint64_t)accessible_size - offset)) return 0;
  if (offset > (uint64_t)SIZE_MAX || length > (uint64_t)SIZE_MAX) return 0;
  *safe_offset = (size_t)offset;
  if (offset >= (uint64_t)accessible_size) {
    *accessible_offset = accessible_size;
    *accessible_length = 0;
  } else {
    size_t available = accessible_size - (size_t)offset;
    *accessible_offset = (size_t)offset;
    *accessible_length = length < (uint64_t)available ? (size_t)length : available;
  }
  return 1;
}

static inline int bend_external_windows_overlap(
    size_t first_offset,
    size_t first_length,
    size_t second_offset,
    size_t second_length) {
  if (first_length == 0 || second_length == 0) return 0;
  if (first_offset <= second_offset) return second_offset - first_offset < first_length;
  return first_offset - second_offset < second_length;
}

#endif
