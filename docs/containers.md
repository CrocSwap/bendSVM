# Bounded generic vectors

`sdk/buffer.bend` supplies ordinary checked Bend definitions for fixed storage
with a runtime length. No application-specific compiler lowering is involved.

- `Pair<T>` stores two elements; `Pair<Pair<T>>` stores four.
- `Vector<T,S>` stores a U32 length and a concrete storage value of type `S`.
- `Result<T>` is `Invalid` or `Valid{value}`.
- `empty` sets the length to zero while retaining caller-supplied backing storage.
- `get` accepts only `length <= capacity` and `index < length`.
- `set` checks the same bounds, preserves length and updates one element.
- `push` requires `length < capacity`, writes at the previous length and increments
  length. A full or malformed vector returns `Invalid`.

Element/storage types, capacity and read/write functions are compile-time
parameters. The pinned checker specializes these into concrete first-order
functions. No function pointer or closure exists at runtime. See
`tests/buffer.bend` for U32/capacity-four and Bool/capacity-two adapters.

The low-level `pair_get`, `pair_set`, `quad_get` and `quad_set` helpers assume a
valid storage index. Use the vector operations at application boundaries. When
supplying a custom storage adapter, its declared capacity must match its storage,
reads must select the requested element, and writes must preserve other elements.
The current proofs establish these properties for the supplied two/four-slot
fixtures; they do not certify arbitrary caller-supplied adapters.

Inactive storage remains part of the fixed-width canonical wire representation.
The length controls logical membership; it does not shrink account allocations.
Malformed logical lengths have valid wire encodings but are rejected by vector
operations. This storage library adds no heap allocation. `sdk/fold.bend` combines it with
the bounded runtime iteration library.

## Evidence

`npm run test:buffer` runs 181 independent expected-result comparisons through
Bend evaluation, generated native C with ASan/UBSan, and LiteSVM SBF execution.
Cases include empty, partial and full vectors, malformed lengths, each slot,
indices at the logical and physical bounds, and U32 maximum lengths/indices.

`npm run verify:buffer` exports checked source and proves access, replacement and
append against independent symbolic array specifications. Payloads, lengths and
indices are universally quantified, including malformed lengths. Four source
mutations test full-capacity overflow, off-by-one access, unrelated-element
corruption and a missing length increment. They must produce counterexamples,
not timeouts. The report includes source/model-driver hashes and the Bend pin.

These are source-model proofs and execution tests. The compiler, model exporter,
primitive model, solver, native/SBF toolchains and runtime remain trusted.

## Fallible left fold

`sdk/fold.bend` supplies `fold(T, S, A, capacity, read, reduce, fuel, vector, initial)`.
The first six parameters specialize at compile time. The reducer has type
`A -> T -> Result<A>`; failure is absorbing. Each loop iteration reads the next
logical element and applies the reducer in order. Success requires fuel exactly
equal to logical length, length within capacity, and every read/reduction to
succeed. Empty vectors succeed with zero fuel and the initial accumulator.

The fixtures exercise checked U32 sums, a noncommutative rolling calculation and
Boolean conjunction. `npm run test:fold` passes 1,092 Bend/native/SBF comparisons
with a maximum of 1,258 CU on the current fixtures. The source proof compares the active prefix with independent
mathematical specifications for arbitrary payloads and lengths at every admitted
fuel value. It partitions sum overflow by the first overflowing prefix and uses
Z3's bit-vector tactic; all partitions must prove unsatisfiable. A solver timeout
is a test failure. Wrong traversal, missing length agreement and ignored overflow
are source mutations checked by `npm run verify:fold`.

The fold requires a valid storage adapter and does not certify arbitrary reducer
invariants. An application can retain detailed error codes by choosing an
accumulator containing its own error/result type; the outer `Invalid` still
represents a failed fold contract.

## Pair-tree prefix fold

`sdk/tree-fold.bend` provides `fold4(T, A, reduce, fuel, vector, initial)` and
`fold32` for the corresponding homogeneous Pair-backed vectors. These are
ordinary checked Bend definitions. They preserve the indexed fold's result
contract: exact Nat fuel/length agreement, length within capacity, left-to-right
reduction of the active prefix, and absorbing reducer failure. Zero-length
vectors preserve the initial accumulator. The capacity bounds one vector; it
does not impose a limit on an application's total elements.

The traversal reduces full subtrees directly and skips empty subtrees, avoiding
dynamic leaf selection and a vector carried through every iteration. Internal
tree helpers assume a valid prefix; use `fold4` or `fold32` at boundaries. This
API adds no compiler intrinsic or wire representation.

`npm run test:tree-fold` checks 5,712 independent expected results through Bend,
sanitizer-enabled native C and SBF. It exercises every admitted fuel value
(0–64), every prefix length, malformed lengths including U32 maximum,
noncommutative reductions, U32 and compound/U64 specializations, failure at every
leaf, and inactive failure sentinels. Representative cases also run through the
existing indexed fold. Twelve SBF inputs with excessive fuel reject. Three
source controls detect reversed full-pair order, ignored fuel agreement and a
reducer that suppresses failure. These are finite execution and source-mutation
checks, not universal refinements of arbitrary reducers or types. The focused
SBF fixtures use at most 7,298 CU; application costs require their own matched
measurements.

## Static Pair zip fold

`sdk/zip-fold.bend` provides `fold2`, `fold4`, `fold8`, `fold16` and `fold32`
for two homogeneous Pair trees. The element and accumulator types and the
`A -> T -> T -> A` transition specialize at compile time. Each function visits
corresponding leaves exactly once, left to right. It always visits the full
fixed tree; a caller with an active prefix must keep its bound in the
accumulator and make the transition ignore inactive leaves. This is a source
traversal choice, with no new compiler intrinsic or wire layout.

`npm run test:zip-fold` checks a noncommutative rolling calculation on ten
32-leaf fixtures against independent expected values through Bend reference
evaluation, sanitizer-enabled native C and SBF. The
[linear-row benchmark](linear-benchmark.md) uses the same generic fold with
a U32/checked-arithmetic accumulator and checks 21 independent-oracle SBF
fixtures twice against Rust. These are execution checks of the exercised
specializations, not a universal proof for arbitrary `T`, `A` or transitions.

## Runtime-length token effects

`sdk/effect-buffer.bend` provides empty/push helpers for a four-slot effect vector.
The shared token adapter accepts homogeneous Pair-backed effect vectors with
capacities two, four or eight, subject to the existing value/stack/wire limits.
It derives capacity from the checked storage layout, validates structural tags
and length, and extracts only active-prefix slots. Inactive slots become no-ops.
Existing two/three-field effect records keep their layout and behavior. General
CPI vectors are not supported by this extension.

`npm run test:effect-buffer` builds a shared-adapter SBF fixture and checks native
extraction under sanitizers. It covers lengths zero through four, invalid lengths,
inactive transfers and malformed schemas. The batch-settlement fixtures exercise
real-token execution at all four batch lengths and rollback after a late CPI
failure. The full regression and source refinement suites passed, as recorded in
[the acceptance review](containers-acceptance-audit.md).
