#pragma once
/* Minimal adapter for Solana's aligned loader ABI. The loader provides a valid
 * serialized buffer; instruction bytes and account contents remain untrusted.
 * The entrypoint sets the account-count bound. This per-account decoder rejects
 * duplicate-account aliases; supported entrypoints require distinct accounts.
 */
typedef unsigned char u8;
typedef unsigned int u32;
typedef unsigned long long u64;
_Static_assert(sizeof(u8) == 1 && sizeof(u32) == 4 && sizeof(u64) == 8, "ABI widths");

static inline u64 read_le(const u8 *p, unsigned n) {
  u64 v = 0;
  for (unsigned i = 0; i < n; ++i) v |= (u64)p[i] << (8 * i);
  return v;
}
static inline void write_le(u8 *p, u64 v, unsigned n) {
  for (unsigned i = 0; i < n; ++i) p[i] = (u8)(v >> (8 * i));
}
static inline unsigned equal_key(const u8 *a, const u8 *b) {
  unsigned difference = 0;
  for (unsigned i = 0; i < 32; ++i) difference |= a[i] ^ b[i];
  return difference == 0;
}
typedef struct {
  const u8 *key;
  const u8 *owner;
  u8 *data;
  u64 size;
  u64 *lamports;
  u64 rent_epoch;
  unsigned signer, writable, executable;
} Account;

static inline const u8 *read_account(const u8 *p, Account *a) {
  if (p[0] != 255) return (const u8 *)0; /* Duplicate-account alias. */
  a->signer = p[1] != 0;
  a->writable = p[2] != 0;
  a->executable = p[3] != 0;
  a->key = p + 8;
  a->owner = p + 40;
  a->size = read_le(p + 80, 8);
  a->lamports = (u64 *)(p + 72);
  a->data = (u8 *)(p + 88);
  /* Loader-provided lengths and realloc padding, followed by rent_epoch. */
  u64 next = (u64)(a->data + a->size + 10240);
  const u8 *rent = (const u8 *)((next + 7) & ~(u64)7);
  a->rent_epoch = read_le(rent, 8);
  return rent + 8;
}

extern void sol_set_return_data(const u8 *, u64);
