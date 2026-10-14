# Canonical codec assurance

Canonical bytes cross the instruction, account and return-data boundaries.
The current evidence combines restricted generated-C conformance checks,
small solver lemmas, and execution tests. It does **not** establish an
end-to-end verified compiler or production readiness.

## Scalar bridge

`npm run verify:codec-primitives` compares emitted U32, Bool and Nat codec
bodies to reviewed exact C templates. Z3 checks byte packing, roundtrip and
range predicates; deliberately wrong models must produce counterexamples.
The accepted primitive identities are U32, Bool and Nat bounded by 64.
C integer widths, memory validity and the interpretation of those templates
remain assumptions. See `build/codec-primitives-refinement.json`.

## Structured generated-C conformance

`npm run verify:codec-structures` freshly runs the scalar bridge, checks Bend
sources and writes native headers, wire headers and schemas for 11 selections:
packet and nested fixtures, generics, collections, vault, vesting, exchange,
AMM, batch, queue, and a boundary fixture with 256 constructors and a
1,024-byte canonical value. It reads the written headers back into a separate
Python checker, rather than validating a second emission.

The checker independently computes the schema layout and accepts only a
restricted codec grammar. It requires exact size guards, constructor cases,
child types, field order, constructor arguments, failure propagation, padding
checks and complete public-encoder zeroing. It checks native type declarations
and constructor makers as balanced token sequences. Preprocessor constructs
outside isolated size macros and the expected include/pragma reject; alternate
line terminators, splices, trigraphs and digraphs reject. Native headers cannot
define or call codec entrypoints. Arbitrary Bend function bodies in those
headers are outside this checker’s semantic claim.

For each parsed constructor, Z3 checks address correspondence, child slice
bounds and byte-array assembly. A dependency-ordered structural argument uses
exact child calls and scalar base cases; all-zero encodings receive child
certificates before a parent is checked. The solver does not interpret C.
Many checks are syntactic or concrete equalities, so the number of solver
queries is **not** a measure of compiler coverage or proof strength.

The report is `build/codec-structures-refinement.json`. It records input,
imported Bend source, generated artifact and checker hashes, assumptions,
solver results and mutation rejection reasons. The driver removes a previous
success report before prerequisites and publishes the new report only after
all checks and report validation succeed. The 47 deliberate C and schema mutations
include wrong offsets, tags, field order, bounds, ignored failures, shortened
zeroing, preprocessing tricks, comment decoys, recursive schemas and wire
size overflow. A timeout or unexpected rejection reason fails the command.

### Limits

- This checks recorded generated instances; it is not a theorem about every
  output the compiler could generate, and ordinary builds do not run it.
- The Python parser/checker, layout specification, primitive template review,
  Z3 and report driver are trusted. They are not formally verified.
- Schema extraction and correspondence to Bend meaning remain outside the
  claim. Source-law checking is a separate assurance layer.
- The claim assumes 32-bit `bend_u32`, eight-bit bytes, initialized active
  native fields, valid buffers and nonoverlapping input/output/value regions.
  Internal ADT writers require a zeroed output region; external callers must
  enter through public encode/decode functions. External callers are not
  verified by this command.
- Failed encode/decode calls can modify local output before rejecting. Callers
  must discard that output. Adapter commit checks cover a separate boundary.
- Clang/LLVM/LLD transformations, target ABI, loader metadata, syscalls and
  deployed SBF behavior are not proven by these checks.

## Native and SBF execution matrix

`npm run test:codec-structures` uses nested ADTs containing empty constructors,
Bool, Nat and U32 fields, with repeated nested types and padding. It compares
16 valid values with checked Bend and native execution, builds the SBF
fixture, and checks 3,409 valid/malformed wire cases against the independent
TypeScript canonical codec. Of those cases, 2,236 must reject. The native
matrix uses AddressSanitizer and UndefinedBehaviorSanitizer, dirty output
buffers and sentinels. Accepted identity results must match exactly; rejected
calls must report no committed output length and preserve sentinels.

After that command generates the artifacts, run:

```sh
cargo test --locked --test sbf codec_structures -- --nocapture
```

The SBF test executes the same matrix in LiteSVM against the compiled ELF;
acceptance, return bytes and rejection code must agree. `npm test` includes
fixture generation, the native matrix and the SBF test. These are finite
execution tests, not a universal machine-code proof. Evidence lives in
`build/codec-structures-runtime-matrix.json` and the generated runtime fixture
artifacts; it applies to those inputs and binaries.
