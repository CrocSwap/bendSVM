/* Native harness for tests/effect-extraction.ts.
 *
 * The including translation unit first includes one fixture's written
 * program.h (generated types), runtime/solana_min.h and the helper text cut
 * byte-for-byte from the written program.c (bend_extract_effect and
 * bend_extract_effects, which pull in token.h or bend_cpi.h), defines the
 * parameters below and efx_slot(), then includes this file.
 *
 * What is real: the emitted extraction helpers, write_le, the BendTransfer /
 * BendInvoke layouts and the generated native types. Inputs are built by the
 * generated *_make constructors in a separately compiled cases object.
 * Nothing is mocked; the token/CPI validate and execute helpers are compiled
 * but never called.
 *
 * Required parameters:
 *   EFX_KIND      1 token (BendTransfer), 2 CPI (BendInvoke)
 *   EFX_VALUE_T   generated C type of the Effects record or vector
 *   EFX_SLOTS     number of output slots
 *   static const <effect type> *efx_slot(const EFX_VALUE_T *, unsigned)
 *
 * Output, one line per call, flushed immediately:
 *   E <case> <rc> <input-unchanged> <pre-guard> <post-guard> <slot;slot;...|->
 *   S <case> <slot> <rc> <input-unchanged> <pre-guard> <post-guard> <slot|->
 * Every byte of each output slot is printed when rc is 1. Mode `guard` puts
 * one patterned element before and after the output array and reports whether
 * each is intact; mode `exact` allocates exactly the output array so that a
 * write outside it is an ASan heap-buffer-overflow.
 */
#pragma once
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if EFX_KIND == 1
typedef BendTransfer EfxOut;
_Static_assert(sizeof(BendTransfer) == 6 * 4 + 32 + 32 + 8 + 4 * 4 + 32 + 32, "every BendTransfer byte is a dumped field");
#elif EFX_KIND == 2
typedef BendInvoke EfxOut;
_Static_assert(sizeof(BendInvokeMeta) == 3 * 4 + 32, "every BendInvokeMeta byte is a dumped field");
_Static_assert(sizeof(BendInvoke) == 4 * 4 + 32 + 64 + 8 * sizeof(BendInvokeMeta), "every BendInvoke byte is a dumped field");
#else
#error "EFX_KIND must be 1 or 2"
#endif

extern const unsigned efx_case_count;
extern const unsigned efx_value_bytes;
extern void efx_build(unsigned id, void *value);

#define EFX_PREFILL 0xA5u
static u8 efx_guard_byte(size_t i, unsigned salt) { return (u8)(0xC3u ^ (i * 29u + salt)); }

static void efx_hex(const u8 *p, size_t n) {
  for (size_t i = 0; i < n; ++i) printf("%02x", p[i]);
}
static void efx_dump(const EfxOut *o) {
#if EFX_KIND == 1
  printf("%u,%u,%u,%u,%u,%u,", o->active, o->source, o->destination, o->mint, o->authority, o->recipient);
  efx_hex(o->mint_key, 32); putchar(','); efx_hex(o->recipient_key, 32);
  printf(",%llu,%u,%u,%u,%u,", o->amount, o->initialize, o->source_bound, o->destination_bound, o->fresh_destination);
  efx_hex(o->source_key, 32); putchar(','); efx_hex(o->destination_key, 32);
#else
  printf("%u,%u,%u,%u,", o->active, o->program, o->length, o->count);
  efx_hex(o->program_key, 32); putchar(','); efx_hex(o->data, 64);
  for (unsigned i = 0; i < 8; ++i) {
    printf(",%u,%u,%u,", o->metas[i].index, o->metas[i].writable, o->metas[i].signer);
    efx_hex(o->metas[i].key, 32);
  }
#endif
}

/* slot < 0 calls bend_extract_effects; otherwise bend_extract_effect on that slot. */
static void efx_call(int exact, unsigned id, int slot, const EFX_VALUE_T *value, const EFX_VALUE_T *copy) {
  const unsigned n = slot < 0 ? EFX_SLOTS : 1;
  const size_t bytes = n * sizeof(EfxOut), guard = exact ? 0 : sizeof(EfxOut);
  u8 *box = malloc(bytes + 2 * guard);
  if (!box) { fprintf(stderr, "effect-extraction harness: out of memory\n"); exit(3); }
  for (size_t i = 0; i < guard; ++i) { box[i] = efx_guard_byte(i, 1); box[guard + bytes + i] = efx_guard_byte(i, 2); }
  memset(box + guard, EFX_PREFILL, bytes);
  EfxOut *out = (EfxOut *)(void *)(box + guard);
  int rc = slot < 0 ? bend_extract_effects(value, out) : bend_extract_effect(efx_slot(value, (unsigned)slot), out);
  int pre = 1, post = 1;
  for (size_t i = 0; i < guard; ++i) {
    if (box[i] != efx_guard_byte(i, 1)) pre = 0;
    if (box[guard + bytes + i] != efx_guard_byte(i, 2)) post = 0;
  }
  if (slot < 0) printf("E %u", id); else printf("S %u %d", id, slot);
  printf(" %d %d %d %d ", rc, memcmp(value, copy, sizeof *value) == 0, pre, post);
  if (rc == 1) for (unsigned i = 0; i < n; ++i) { if (i) putchar(';'); efx_dump(&out[i]); }
  else putchar('-');
  putchar('\n');
  fflush(stdout);
  free(box);
}

int main(int argc, char **argv) {
  if (argc != 2 || (strcmp(argv[1], "guard") && strcmp(argv[1], "exact"))) {
    fprintf(stderr, "usage: %s guard|exact\n", argv[0]); return 2;
  }
  if (efx_value_bytes != sizeof(EFX_VALUE_T)) { fprintf(stderr, "effect-extraction harness: value type mismatch\n"); return 3; }
  const int exact = argv[1][0] == 'e';
  for (unsigned id = 0; id < efx_case_count; ++id) {
    /* Exactly sized heap objects: an out-of-bounds read of the input is reported by ASan. */
    EFX_VALUE_T *value = malloc(sizeof *value), *copy = malloc(sizeof *copy);
    if (!value || !copy) { fprintf(stderr, "effect-extraction harness: out of memory\n"); return 3; }
    efx_build(id, value);
    memcpy(copy, value, sizeof *value);
    efx_call(exact, id, -1, value, copy);
    for (unsigned s = 0; s < EFX_SLOTS; ++s) efx_call(exact, id, (int)s, value, copy);
    free(value); free(copy);
  }
  puts("done");
  return 0;
}
