# Bend reference cache

`tests/pure.ts` checks every pure test case three ways: the independent
TypeScript oracle, the Bend interpreter (`term_snf`) on the checked book, and
the generated C/SBF code. The interpreter is by far the slowest part of
`npm test`; `sqrt` alone took 910 s cold.

`tests/bend-reference-cache.ts` stores each interpreter result under
`build/.bend-reference-cache/`, keyed by the SHA-256 of everything that can
affect it:

- every checked Bend source file of the module (paths and bytes);
- the pinned interpreter/checker `.deps/bend/bend2/bend.ts` and `base.bend`;
- `compiler/backend.ts` (it loads and checks the book), `tests/pure.ts` (term
  conversion), `sdk/wire.ts` (result encoding) and the cache module itself;
- the emitted schema;
- the case's root name and arguments.

Changing any of these misses and re-evaluates. On a hit the cached result is
still compared with the TypeScript oracle and the native/SBF results; only the
interpreter run is skipped. Each module records its counts in
`<stem>-reference-cache.json`, and the test log reports evaluated/cached cases.

| `BEND_REFERENCE_CACHE` | Behaviour |
| --- | --- |
| `use` (default) | Reuse valid entries; evaluate and store misses |
| `verify` | Evaluate every case and fail if a cached entry differs |
| `refresh` | Evaluate every case and overwrite entries |
| `off` | Evaluate every case; never read or write the cache |

A cached result is evidence from the run that produced it, not a fresh
interpreter execution. For acceptance records that claim fresh interpreter
evidence, run with `BEND_REFERENCE_CACHE=verify` (or `off`). Deleting
`build/.bend-reference-cache/` is always safe. `tests/bend-reference-cache-controls.ts`
(run by `npm test`) checks hits, case/schema/source misses, tamper detection in
verify mode, corrupt-entry recovery and off mode.

## Measured — 2026-10-09 (macOS arm64)

`sqrt`: 910 s cold, 1 s warm. Full `npm test`: 944 s while populating every
other module (with `sqrt` already cached), 314 s warm; both passed
(`build/regression/20261009T230828Z-reference-cache/`). The populating run evaluated 9,220 cases fresh;
the 442 `sqrt` and `iteration` entries came from earlier standalone runs that day. With warm caches the
remaining time is spread over adapter, differential and SBF sections (10–30 s
each); further gains would need running modules in parallel.

Interpreter calls in `tests/arithmetic.ts`, `tests/codecs.ts` and
`tests/sha256-reference.ts` are not cached.
