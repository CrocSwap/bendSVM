#pragma once
#include "solana_min.h"

/* ABI-3 collection: 20-byte schema header, u32 logical length, state key,
 * followed by fixed-width canonical records. The generated adapter supplies
 * the element codec and validates every active record it loads. No full-account
 * copy is needed. This layer trusts loader-provided account pointers/lengths. */
#define BEND_COLLECTION_HEADER 56u
typedef struct {
  Account *account;
  u32 length, capacity, stride;
} BendCollection;
typedef struct {
  u32 start, reserved, loaded;
} BendCollectionWindow;

/* Does not mutate bytes, including during initialization. Error values are
 * shared adapter errors: 3 owner, 4 layout, 5 writable, 7 initialization signer. */
static inline u64 bend_collection_open(Account *a, const u8 *program,
    const u8 *state_key, const u8 header[20], u32 stride, unsigned initialize,
    BendCollection *out) {
  if (!equal_key(a->owner, program) || a->executable) return 3;
  if (!a->writable) return 5;
  if (!stride || a->size < BEND_COLLECTION_HEADER) return 4;
  u64 payload = a->size - BEND_COLLECTION_HEADER;
  if (payload % stride || payload / stride > 0xffffffffULL) return 4;
  u32 capacity = (u32)(payload / stride), length = 0;
  if (initialize) {
    if (!a->signer) return 7;
    for (u64 i = 0; i < a->size; ++i) if (a->data[i]) return 4;
  } else {
    for (unsigned i = 0; i < 20; ++i) if (a->data[i] != header[i]) return 4;
    if (!equal_key(a->data + 24, state_key)) return 4;
    length = (u32)read_le(a->data + 20, 4);
    if (length > capacity) return 4;
  }
  *out = (BendCollection){a, length, capacity, stride};
  return 0;
}

static inline unsigned bend_collection_select(const BendCollection *c,
    u32 start, u32 count, u32 maximum, BendCollectionWindow *out) {
  if (c->length > c->capacity || start > c->length || count > maximum ||
      start > c->capacity || count > c->capacity - start) return 0;
  u32 available = c->length - start;
  *out = (BendCollectionWindow){start, count, available < count ? available : count};
  return 1;
}

/* Only call after select. Multiplication and addition use u64; each factor is
 * u32 and open established that the entire allocation fits the loader length. */
static inline const u8 *bend_collection_record(const BendCollection *c,
    const BendCollectionWindow *w, u32 local) {
  if (local >= w->loaded) return (const u8 *)0;
  return c->account->data + BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride;
}

/* A transition replaces all active records in its window. It may append only
 * if the old window reaches the logical tail. Existing records cannot vanish.
 * Validate this and encode all records before any effects/account mutation. */
static inline unsigned bend_collection_plan(const BendCollection *c,
    const BendCollectionWindow *w, u32 written, u32 next_length) {
  BendCollectionWindow expected;
  if (!bend_collection_select(c, w->start, w->reserved, w->reserved, &expected) ||
      expected.loaded != w->loaded || written < w->loaded || written > w->reserved ||
      next_length < c->length || next_length > c->capacity) return 0;
  u32 added = written - w->loaded;
  if (added && c->length - w->start != w->loaded) return 0;
  return added == next_length - c->length;
}

/* Trusted commit: caller has successfully run plan and all canonical encoders,
 * validated effects, and executed them. encoded must be a separate scratch
 * buffer of written * stride bytes. No failure remains in this operation. */
static inline void bend_collection_commit(BendCollection *c,
    const BendCollectionWindow *w, u32 written, u32 next_length,
    const u8 *encoded, const u8 header[20], const u8 *state_key) {
  u8 *data = c->account->data;
  u64 offset = BEND_COLLECTION_HEADER + (u64)w->start * c->stride;
  for (u64 i = 0; i < (u64)written * c->stride; ++i) data[offset + i] = encoded[i];
  for (unsigned i = 0; i < 20; ++i) data[i] = header[i];
  write_le(data + 20, next_length, 4);
  for (unsigned i = 0; i < 32; ++i) data[24 + i] = state_key[i];
  c->length = next_length;
}
