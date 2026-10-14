# Packed multiblock SHA qualification

The SDK reference in `sdk/sha256-packed.bend` accepts lengths 0–151, including
DCG's 138-byte Merkle parent preimages. `Bytes160` stores 40 U32 words, each
packing four bytes in little-endian order. The first 32 words form a five-level
binary Pair tree; the final eight form a three-level tail. Canonical library
input is 204 bytes and output is 34 bytes. Inactive bytes are ignored; every
U32 packed word is valid. Longer lengths return `Rejected`.

Ordinary builds execute the Bend SHA implementation. An explicit intermediate
operation substitutes its internal hash function:

```ts
import {emitSha256PackedQualifiedSbf} from './compiler/sha256-packed-qualified-emission.ts';
const emission = await emitSha256PackedQualifiedSbf(
  'tests/sha256-packed-reference/PROOF.bend', ['program.hash_packed'],
);
```

Run from the repository root using pinned Bun. This operation accepts source
and ordinary runtime roots only. Its result is C plus descriptive evidence,
not a final-image authorization token.

The maintained packed library command publishes a qualified SBF object and
retains ordinary checked-source host C:

```sh
npm run build:sha256-packed-library -- tests/sha256-packed-reference/PROOF.bend program.hash_packed build/sha-packed-library
```

The three arguments are source, runtime root and output directory. The command
derives fresh qualification using the packed catalog; callers cannot supply
pins, receipts or a qualification profile. The short library command continues
to select its separate short-SHA catalog. Ordinary library builds remain
source-generated.

The [qualified library publication lifecycle](sha256-qualified-library.md)
applies to both commands: exclusive lock, prior active-receipt retirement,
immutable generation and artifact/input checks, then active receipt publication
last. The packed receipt has kind `sha256-packed-qualified-library-v1` and
`qualificationProfile: "packed"`. It never authorizes the final linked ELF;
the consumer must check that image's imports, stack, call depth and exact bytes.

## Identity and substitution

The [catalog](../compiler/sha256-packed-qualification-pins.json) binds one
reviewed 155-definition checked runtime graph rooted at
`$module:sha256-packed.hash_bounded`. It uniquely binds full source bytes for
packed SHA, the short reference's compression helpers, buffer and iteration,
then derives canonical names from the actual checked loader origins. Relocation
and unrelated generic instance renumbering preserve that graph identity.
An unrelated exact dependency cannot authorize a changed dependency used by
the hash implementation. The old prototype's saved library manifest is not an
authorization input.

The operation preserves the ordinary proof/subset gates. It requires the hash
target to remain an internal transitive function. A checked-schema generator
validates the exact packed tree, constructor order, tags, field types, unsigned
U32 representation, digest order and C identifiers. It extracts active bytes,
calls the SHA syscall once, traps on syscall error, and converts the digest to
eight big-endian U32 words. Only the exact internal definition is replaced;
other function bodies and the public schema remain unchanged.

The same checked book is identified before and after synchronous emission and
replacement. Loaded source, pinned support, the normalized emitter, catalog,
Bend checkout and Bun executable are checked before/after. Current pins cover
Bun 1.4.2 on darwin-arm64. Pins must be reviewed when implementation inputs
change; the operation cannot refresh or accept caller-created pins.

## Permanent checks and evidence scope

```sh
npm run test:sha256-packed-qualified-emission
npm run test:sha256-packed-lowering
npm run test:sha256-packed-sbf
npm run test:sha256-packed-qualified-library
```

The identity test exercises semantic source, origin, schema, compiler/catalog
and same-book mutation refusals, relocation and fresh restored positives.
Lowering checks compare every length 0–151 with two inactive-byte patterns,
`abc`, rejected lengths and malformed canonical input against Node crypto.
Ordinary emitted C and the qualified syscall stub run under ASan/UBSan. Stub
checks include exact active bytes, length, slice count, digest order and syscall
error after writing the digest. Compiled byte, length and digest mutants must
fail for semantic mismatches. The selected SBF object must expose genuine
SHA/abort imports and satisfy the 4,096-byte frame limit.

The SBF test performs a fresh lowering run, links ordinary and qualified
objects into a minimal Rust shell, checks final SBPFv0 imports and stack sizes,
and uses the maintained final-artifact/call-depth gate. It checks refusal for
missing imports and changed final-image bytes, then compares the same cases in
LiteSVM against Node crypto. It retains its executing runner and exact input,
artifact and raw execution hashes in a unique build directory. The 1.4 million
CU budget is an explicit fixture setting, not a worst-case bound.

The packed library acceptance runs the real CLI through nine failure/locking
controls, checks preservation of the prior receipt and every prior artifact,
and restores a fresh generation. These include the wrong fixed SHA profile,
an actual proof hole, object swaps and failure before receipt publication. A
held lock must refuse without retiring existing success. It then runs 308
ordinary-host cases under ASan/UBSan and 309 cases on each ordinary/qualified
Rust-linked image, with genuine import, stack and final artifact/call-depth
checks. Its retained runner and raw execution evidence are recorded under
`build/sha256-packed-qualified-library/run-<id>/`.

The five Bend laws cover selected length and padding boundaries; they do not
prove SHA correctness. Source qualification, finite oracle/mutation evidence,
final-image acceptance and publication lifecycle remain distinct. Valid ABI
memory, checked-language/LLVM semantics, the SHA syscall, runtime and stable
trusted process/filesystem remain assumptions. These checks do not establish
universal SHA equivalence, an end-to-end verified compiler, account-address
provenance or production readiness.

## Recorded acceptance — 2026-10-05

Current focused qualification passed 31 identity/schema/support controls,
309 cases per native implementation (618 executions), four detected compiled
semantic mutants, syscall-error trapping, and 309 cases per final linked image
(618 LiteSVM executions). The source/helper graph has 155 definitions; ordinary
SBF maximum frame is 1,728 bytes and the qualified object maximum is 704 bytes.

The 138-byte poisoned-inactive-byte case measured 339,220 CU for the ordinary
implementation and 2,356 CU for the qualified implementation in the same
minimal Rust shell, including the fixture's compute-budget instruction. This
compares two Bend implementations through Rust; it is not an independent Rust
SHA baseline or a worst-case claim.

Exact current source, tool, report, artifact and final-image receipt bindings
were audited across 117 dependencies in
`build/sha-packed-qualification/audit.json`. Source-emission report:
`build/sha256-packed-qualified-emission/82979116-588d-45f8-a924-15cfa2f04356/report.json`.
Native and final-image reports:
`build/sha256-packed-lowering/b537045a-3ff0-4e5c-a153-7f6ffa194059/{report.json,sbf/report.json}`.
The earlier SBF attempt rejected a changed package-command inventory; its
partial output is preserved and does not establish completed acceptance.
Packed publication acceptance subsequently passed nine controls, 308 native
cases and 309 cases per linked image in
`build/sha256-packed-qualified-library/run-1c478b1e-8a12-4681-ac71-e4b284c38185/report.json`;
the short publication replay passed the same nine controls, 64 native cases
and 65 cases per image in
`build/sha256-qualified-library/run-40a8ac96-f869-4702-b636-c2bcaaf194f4/report.json`.
These fresh replays include the corrected report-profile field and expanded
imported-input binding. Their independent publication audit checks 197 bindings:
`build/sha-packed-publication/publication-audit-89735172-a916-414f-8973-693ed2ef88f6.json`.
The fresh 31-control source/root replay is
`build/sha256-packed-qualified-emission/aff7e759-edba-4b1e-98f8-47a0179b9f77/report.json`;
its source-origin audit is `build/sha-packed-publication/identity-audit.json`.

On 2026-10-06 UTC, integrated `npm test` passed with no drift in 931 recorded
sources. The broad run, independent audit and ordered-check finisher are in
`build/overnight/regression-fe0d9b24-b3ed-4a8e-9d95-4ccbb4c3e19f/`.
Afterward, `tests/program-client.ts`, `tests/project-commands.ts` and
`tests/client-packaging.ts` passed in CI order; their source/log audit is in
`build/sha-library-integration/client-checks-e90c502a-b26f-49f1-bd78-b0b0c7367e44/`.
Both directories contain successful `terminal.json` and `handoff-audit.json`;
the broad directory also contains `finish.json`. These checks were audited
before the documentation updates recording them. The full 55-command
refinement aggregate remains separate and has not passed; DCG identity and
local-handler integration are still outstanding.
