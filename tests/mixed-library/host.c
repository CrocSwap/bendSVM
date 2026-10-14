#include "library.h"
#include <stddef.h>
#include <string.h>

#define SENTINEL UINT64_C(0x1122334455667788)

static int same(const uint8_t *left, const uint8_t *right, uint64_t length) {
  for (uint64_t i = 0; i < length; ++i) if (left[i] != right[i]) return 0;
  return 1;
}

static void fill(uint8_t *bytes, uint64_t length, uint8_t value) {
  for (uint64_t i = 0; i < length; ++i) bytes[i] = value;
}

static int rejected_unchanged(const uint8_t *input, uint64_t input_len,
    uint64_t output_capacity, uint32_t expected_status) {
  uint8_t output[8];
  const uint8_t expected[8] = {0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5};
  uint64_t output_len = SENTINEL;
  fill(output, sizeof(output), 0xa5);
  const uint32_t status = BEND_LIBRARY_CALL(input, input_len, output, output_capacity, &output_len);
  return status == expected_status && output_len == SENTINEL && same(output, expected, sizeof(output));
}

int main(void) {
  const uint8_t accepted_input[] = {0, 1, 0, 0, 0, 0};
  const uint8_t accepted[] = {0, 2, 0, 0, 0};
  const uint8_t disabled_input[] = {0, 0, 41, 0, 0, 0};
  const uint8_t refused[] = {1, 41, 0, 0, 0};
  uint8_t output[8];
  uint64_t output_len = 0;

  fill(output, sizeof(output), 0xa5);
  if (BEND_LIBRARY_CALL(accepted_input, sizeof(accepted_input), output, sizeof(output), &output_len) != BEND_LIBRARY_ABI_OK ||
      output_len != BEND_LIBRARY_OUTPUT_BYTES || !same(output, accepted, BEND_LIBRARY_OUTPUT_BYTES)) return 1;

  fill(output, sizeof(output), 0xa5);
  output_len = 0;
  if (BEND_LIBRARY_CALL(disabled_input, sizeof(disabled_input), output, sizeof(output), &output_len) != BEND_LIBRARY_ABI_OK ||
      output_len != BEND_LIBRARY_OUTPUT_BYTES || !same(output, refused, BEND_LIBRARY_OUTPUT_BYTES)) return 2;

  const uint8_t bad_bool[] = {0, 2, 0, 0, 0, 0};
  if (!rejected_unchanged(bad_bool, sizeof(bad_bool), sizeof(output), BEND_LIBRARY_ABI_MALFORMED_INPUT)) return 3;
  const uint8_t bad_tag[] = {2, 0, 0, 0, 0, 0};
  if (!rejected_unchanged(bad_tag, sizeof(bad_tag), sizeof(output), BEND_LIBRARY_ABI_MALFORMED_INPUT)) return 4;
  const uint8_t bad_padding[] = {1, 0, 0, 0, 0, 1};
  if (!rejected_unchanged(bad_padding, sizeof(bad_padding), sizeof(output), BEND_LIBRARY_ABI_MALFORMED_INPUT)) return 5;
  if (!rejected_unchanged(accepted_input, BEND_LIBRARY_INPUT_BYTES - 1u, sizeof(output), BEND_LIBRARY_ABI_MALFORMED_INPUT)) return 6;
  if (!rejected_unchanged(bad_bool, sizeof(bad_bool), BEND_LIBRARY_OUTPUT_BYTES - 1u,
      BEND_LIBRARY_ABI_MALFORMED_INPUT)) return 7;
  if (!rejected_unchanged(accepted_input, sizeof(accepted_input), BEND_LIBRARY_OUTPUT_BYTES - 1u,
      BEND_LIBRARY_ABI_SHORT_OUTPUT)) return 8;

  fill(output, sizeof(output), 0xa5);
  output_len = SENTINEL;
  if (BEND_LIBRARY_CALL(accepted_input, sizeof(accepted_input), NULL, sizeof(output), &output_len) != BEND_LIBRARY_ABI_NULL ||
      output_len != SENTINEL || !same(output, (const uint8_t[]){0xa5,0xa5,0xa5,0xa5,0xa5,0xa5,0xa5,0xa5}, sizeof(output))) return 9;
  if (BEND_LIBRARY_CALL(accepted_input, sizeof(accepted_input), output, sizeof(output), NULL) != BEND_LIBRARY_ABI_NULL) return 10;
  if (BEND_LIBRARY_CALL(NULL, sizeof(accepted_input), output, sizeof(output), &output_len) != BEND_LIBRARY_ABI_NULL) return 11;

  uint8_t alias[16] = {0, 1, 0, 0, 0, 0};
  output_len = SENTINEL;
  if (BEND_LIBRARY_CALL(alias, BEND_LIBRARY_INPUT_BYTES - 1u, alias, sizeof(alias), &output_len) != BEND_LIBRARY_ABI_ALIAS ||
      output_len != SENTINEL || !same(alias, (const uint8_t[]){0,1,0,0,0,0}, BEND_LIBRARY_INPUT_BYTES)) return 12;

  uint8_t raw_length[sizeof(uint64_t) + 1u];
  memcpy(raw_length + 1u, &(uint64_t){SENTINEL}, sizeof(uint64_t));
  fill(output, sizeof(output), 0xa5);
  const uint32_t misaligned = BEND_LIBRARY_CALL(accepted_input, sizeof(accepted_input), output, sizeof(output),
    (uint64_t *)(void *)(raw_length + 1u));
  if (misaligned != BEND_LIBRARY_ABI_MISALIGNED_OUTPUT_LEN ||
      !same(raw_length + 1u, (const uint8_t *)&(uint64_t){SENTINEL}, sizeof(uint64_t)) ||
      !same(output, (const uint8_t[]){0xa5,0xa5,0xa5,0xa5,0xa5,0xa5,0xa5,0xa5}, sizeof(output))) return 13;

  const uint8_t *wrapped = (const uint8_t *)(uintptr_t)(UINTPTR_MAX - 1u);
  output_len = SENTINEL;
  if (BEND_LIBRARY_CALL(wrapped, BEND_LIBRARY_INPUT_BYTES, output, sizeof(output), &output_len) != BEND_LIBRARY_ABI_RANGE ||
      output_len != SENTINEL) return 14;
  return 0;
}
