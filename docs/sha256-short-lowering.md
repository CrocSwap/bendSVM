# Isolated SHA-256 short-message C lowering

This document describes an **unintegrated building block**. Nothing in the
compiler or build pipeline calls it automatically, and it does not change
ordinary checked-source lowering. A caller must explicitly invoke
`generateSha256Short` from [sha256-short.ts](../compiler/sha256-short.ts) with
the emitted `RuntimeSchema` and a separately reviewed identity record.

## Caller authorization boundary

The generator checks representation. It does not prove that the schema came
from a particular checked body, authenticate Bend source, or identify the
transitive runtime closure. Matching a function name and matching a C layout
are **not source authentication**.

Before a future caller replaces the ordinary body, it must have both:

1. A separately reviewed capability binding the checked body and transitive
   closure to this specialization, with the relevant source/compiler inputs
   frozen and identified.
2. An explicit SBF-only opt-in for that identified program build.

The caller must fail closed when either authorization is absent, stale, or
does not match. It must not infer authorization from `hash_short`, another
function name, or a matching layout. The identity argument to this generator
is a representation contract, not that authorization capability.

The intended integration API is:

```ts
// Pseudocode for a future reviewed SBF build caller, not a current build path.
const authorization = reviewedSha256ShortCapabilityFor(checkedBodyAndClosure);
if (target === 'sbf' && explicitSha256ShortOptIn && authorization.matches(inputs)) {
  const specialized = generateSha256Short(emitted.schema, reviewedSha256ShortIdentity);
  emittedC = replaceExactlyOneDefinition(emittedC, authorization.exportCName, specialized.definition);
}
```

The caller must also decide how the nonreturning failure path is represented in
the final SBF import profile. With the current Anza compiler, `__builtin_trap()`
adds an undefined `abort` symbol; `sol_sha256` is also undefined as expected.
The current generic program import allowlist does not include `abort`. This
building block deliberately does not change that allowlist or define runtime
failure policy. A future integration must use an approved failure hook or
explicitly account for the toolchain's trap lowering before linking.

## Identity and validation

`Sha256ShortIdentity` names the export's source name and emitted C name, the
primitive U32 type, each outer message/result/digest type and constructor, and
the six pair-type names from root to leaf. It also gives every field name and
the eight digest fields in order. There are no inferred defaults.

The schema validator rejects unsupported versions, malformed entries,
duplicate types/constructors/fields/exports/C names, C keywords (including C23
keywords), names reserved by generated locals or included runtime headers,
unknown type references, and recursive types. The selected U32 must be an
unbounded U32 primitive. The specialization then checks:

- Exactly one identified export with one `Message` argument and `HashResult`
  result.
- One `Message` constructor with ordered `length: U32` and `bytes: Bytes64`
  fields; one `Bytes64` constructor with its named words field.
- Six specifically identified, single-constructor binary pair nodes, with
  ordered left/right fields and exactly 64 U32 leaves.
- Exactly the ordered `Rejected{}` and `Hashed{digest}` result constructors,
  followed by one `Digest256` constructor with eight ordered U32 words.
- Constructor identities, tags, field names, field order, and safe C
  identifiers.

After those checks, emitted `cType` and `cMaker` identifiers and the actual
validated tag/field positions build the replacement definition and all 64
slot paths. The generated source does not hard-code the compiler's mangled
type or constructor symbols. Its leading C static assertion requires the
concrete U32 C type to be unsigned and exactly 32 bits. `slotPaths` is available
as layout evidence for the caller and tests; it is not source evidence.

## Generated body behavior

The returned object contains a full replacement `definition`, its body text,
and the 64 checked slot paths. Include `runtime/bend_sha256.h` before the
definition. The generated body:

1. Reads the message length, then returns the actual `Rejected` maker when the
   length exceeds 55, before reading any byte slot.
2. Checks active slots in order, through slot 54 only. Each read is inside its
   `length > index` guard. A U32 above 255 returns `Rejected`; inactive slots,
   including slot 55, do not affect the result.
3. Copies valid active values into a local 55-byte array and passes one local,
   live `BendSha256Slice` to one `bend_sha256_hashv` call. The local slice,
   compact bytes, and output digest remain alive through that call.
4. Traps on every unexpected non-OK wrapper status. It never turns a wrapper
   or syscall failure into `Rejected` or `Hashed`, and does not use
   `__builtin_unreachable` for that branch. The focused host test requires the
   injected syscall failure to terminate with `SIGTRAP` and rejects sanitizer
   diagnostics, so an ASan/UBSan crash cannot count as the intended trap.
5. Converts the 32 returned bytes into eight big-endian U32 values and calls
   the emitted `Digest256` and `Hashed` makers.

The buffers have fixed sizes: 55 compact bytes, one 16-byte SHA slice
descriptor, and a 32-byte digest, in addition to the by-value message and
wrapper locals. The optional Anza compile-only gate records the generated
function's frame and rejects a frame at or above the documented 4,096-byte
limit. This is a resource-shape check; it is not an SBF execution result.

## Focused validation

Run from the repository root with the checked SHA reference sources present:

```sh
bun tests/sha256-short-lowering.ts
```

When those uncommitted prerequisites are outside the assigned worktree, set
`SHA256_SHORT_SOURCE_ROOT` to their read-only root. The test loads the backend
from that source root, runs the checked proof gate, and emits its actual C
header/schema. It compiles the specialized replacement with host Clang under
ASan/UBSan, fatal sanitizer mode, and strict warnings. Its `sol_sha256` mock
checks one descriptor, the exact length and ordered bytes, then supplies
digests computed independently by Node's SHA-256 implementation. The same
harness calls the checked C reference emitted from the actual checked Bend
source and compares result tags and all eight digest words against the
specialization for every valid length and the invalid length/active-byte cases.

The positive cases cover every length from 0 through 55, varied active bytes,
valid bytes 0 and 255, and poisoned inactive slots (including slot 55).
Rejected cases cover length 56, U32 max, and invalid first/last active slots.
Digest fields are checked in big-endian order against both Node SHA-256 and the
checked reference. Permanent negative cases reject bounded Nat, a narrow C U32
alias through the emitted static assertion, and generated-local/runtime/C23
identifier collisions. Compile/run mutations exercise the length guard,
active-slot boundary, byte bound, slot order, digest endianness, and failure
branch. Tool spawn/compiler failures are reported separately from semantic
assertions.

With pinned Anza platform-tools v1.53 available, run the same test with
`SHA256_SHORT_SBF_SHAPE=1` and `SBF_TOOLS` set to its `llvm/bin` directory. It
compiles an object only and records its undefined symbols and `.su` frame
report. This does not link a program, run LiteSVM, run the Solana SHA syscall,
or establish algorithm equivalence. The host mock and finite vectors establish
marshalling/wrapper conformance for the tested cases only; they do not prove
SHA-256 equivalence, the syscall implementation, source-to-binary compiler
correctness, or the checked-source authorization needed by a future caller.

## Exact source prerequisites used for this validation

An earlier focused run used the following SHA-specific main-checkout inputs;
its complete checked dependency snapshot and every hash are preserved in the
private `/tmp/sha256-short-lowering-anza-final5-20261001/evidence.json` report.
That evidence predates the review corrections in this version of the source.

| Main-checkout input | SHA-256 |
| --- | --- |
| `sdk/sha256-reference.bend` | `4eeaec621e7e855cd88abd1b224ee01279b2981c112701f4bfff0f6347d4e447` |
| `runtime/bend_sha256.h` | `6a75b1c5f7aac1835f7fa57e495b6084760f9b05430516872dc2fa13ff6734a1` |
| `compiler/schema.ts` | `c519ee4bfcfb4f62490bd36d6016f043ed390d7bbde92066845f24bcb04337b7` |
| `compiler/backend.ts` | `3d79805cee8b4d135b1c129486514e65483e8bc74e1f66558db174ec259999db` |
| `.deps/bend/bend2/bend.ts` | `baf326d77e81c2ebe80c2bdd016c08732071a56ff951da0a67f68c26ac99e9d4` |
| `tests/sha256-reference.ts` | `1ac6441d0d50d3ccb11897280bd390866521292110077c07183678e13db3e785` |
| `build/overnight/sha_specialization_provenance_scout-result.txt` | `ead0dcee8ed9e9f18fefe0fd216cb131de4531a3ee7c9c3a81ed2a7916bdae1f` |

The proof/law fixture, imported SDK modules, Base source, runtime ABI header,
generator/test hashes, Clang version/flags, and compiler-only object evidence
are included in that report. These hashes identify this validation input set;
they are not a current-source guarantee for future integration.

The U32 representation assertion is inside the returned function body, so both
`body` and `definition` callers retain it. Narrow unsigned and signed aliases
are compiled through both APIs as negative controls. These probes require the
actual `error: static assertion failed` diagnostic and omit conversion warnings,
so a warning that echoes the assertion text cannot count as evidence. Host trap
signal evidence currently covers arm64 macOS; other host architectures need
their own precise expected trap signal before this gate is enabled there.
