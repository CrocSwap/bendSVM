# Generic containers and bounded iteration milestone

Status: complete. This compiler expansion passed its own
[acceptance audit](containers-acceptance-audit.md), separately from the historical
AMM milestone.

## Objective

Support reusable generic containers and bounded iteration, then demonstrate
them in a batch-settlement application with source-level invariants and an
equivalent Rust benchmark.

The runtime representation must remain bounded and compatible with SBF. Reuse
the pinned Bend checker's compile-time specialization where possible. Application
logic belongs in Bend, and reusable language/SDK features must not depend on the
batch application's names. Handwriting a fixed sequence of application calls
does not satisfy iteration support.

## Required evidence

| Requirement | Completion evidence |
| --- | --- |
| Generic data and functions | Concrete specialization of reusable records/tagged unions and functions, including nested and multiple instantiations; deterministic naming/layout and rejection of unresolved parameters |
| Bounded containers | Reusable fixed-capacity storage with runtime length, checked access/update and explicit capacity/overflow behavior; more than one element type and capacity exercised |
| Bounded iteration | Ordinary checked Bend source with an explicit finite bound; actual runtime iteration rather than application-specific unrolling; zero, partial and maximum-length cases, and rejection of unsupported/unbounded recursion |
| Source semantics and proofs | Checked-source models preserve specialization, container behavior and loop bounds; bounds, accumulation/conservation and exact effects connected to application source; mutations demonstrate failures |
| Batch settlement | Funded obligations to multiple recipients, authorization, checked totals, exact token transfers, replay prevention and atomic rollback; batch length varies at runtime |
| Independent Rust baseline | Same protocol, wire/account validation, token effects and error semantics; shared conformance fixtures |
| Fair benchmark | Same SBF target/runtime/accounts/inputs, boundary batch lengths, success and rejection costs, binary sizes, repeatability and source/toolchain hashes |
| Regression and external workflow | Existing applications remain supported; generated interfaces/client and clear build/test/proof/benchmark instructions; acceptance audit against every row |

## Initial application direction

Use a single-asset, escrow-funded batch of settlement obligations. Each obligation
binds a recipient and an amount; funding records the checked aggregate and the
immutable bounded batch. Settlement transfers exactly the recorded obligations
and closes the batch atomically. Authorization and replay guards are part of the
source transition; runtime token checks bind destination owners and the mint.
The exact instruction/account contract will be documented before implementation.
This is a complete token-settlement application, not a quote-only arithmetic probe.

## Implementation sequence

1. Inspect checked template instances and implement concrete generic layouts.
2. Add reusable bounded containers and a precisely restricted iteration lowering.
3. Extend the checked-source model and prove the container/iteration contracts.
4. Implement the settlement protocol and any general SDK effect-collection support.
5. Build the independent Rust program, shared conformance and matched benchmarks.
6. Complete current regression, reproducibility, documentation and acceptance audit.

Source proofs, compiler/runtime tests and performance measurements remain separate
evidence. This milestone does not claim unrestricted Bend compatibility or an
end-to-end verified deployed binary.

## Current implementation evidence

Initial generic specialization is implemented for erased type parameters in
nonrecursive records/unions and checked template functions. The fixture exercises
U32 and Bool instances, nesting, construction and matching. Unsupported template
roots and recursive generic data fail compilation.

`npm run test:generics` currently passes 37 Bend/native/SBF comparisons, 11
universal checked-source model claims and two deliberately faulty source variants.
The proof exporter preserves instantiated type and constructor identities.
The vault, exchange and AMM source-model exports were compared with their prior
artifacts and remained identical; checked-u64 refinement and its mutations pass.
These checks are incremental evidence, not the milestone's full regression audit.

Reusable bounded storage now exists in `sdk/buffer.bend`: `Vector<T,S>` separates
the element and storage types, with static capacity/read/write adapters. The
fixture uses two Bool slots and four U32 slots, including nested pair layouts.
`npm run test:buffer` passes 181 Bend/native/SBF cases (maximum 298 CU on the current compiled fixture).
`npm run verify:buffer` proves seven universal claims, covering arbitrary U32
lengths/indices, payload preservation, exact updates and append overflow; four
source mutations produce counterexamples. Custom adapters still require their
own contracts. This is storage support, not runtime iteration.

Bounded runtime iteration is implemented for direct tail recursion on a strict
predecessor of the first Nat argument. The Nat representation is explicitly
bounded to 0–64; codecs reject larger values and runtime construction is rejected.
The reusable `sdk/iteration.bend` repeat function specializes over state and step.
`npm run test:iteration` passes 325 Bend/native/SBF cases, including all 65 fuel
values, plus SBF oversized-fuel rejection (maximum successful cost 843 CU).
`npm run verify:iteration` proves four fixture contracts over arbitrary payloads
for every admitted fuel value; two source mutations produce counterexamples.
See `docs/iteration.md` for the precise restrictions and proof boundary.

The generic fallible left fold now composes vectors and runtime iteration.
Positive source checks cover all 65 fuels for arbitrary payloads/lengths across
checked sums, ordered reduction and Boolean conjunction. All 1,092
Bend/native/SBF fold cases pass (maximum 1,258 CU); three source mutations
produce counterexamples. Runtime-length token effect vectors compile through
the shared adapter; native extraction checks lengths/inactive slots/schema errors.
The precise next application contract is in `docs/batch-settlement.md`.

Existing three-effect and issuance SBF regressions pass (seven tests), including
late-failure rollback and account bindings. The batch lifecycle additionally
supplies real-token execution and rollback evidence for vector effects.

The batch source now implements funding and settlement using the generic fold
and effect vector. The shared adapter builds it within SBF stack limits after
exported functions and loop functions were given separate call frames. Initial
real-token tests pass across all four batch lengths, including replay, full-u64
amounts, exact custody bindings, donations and late-CPI rollback. Six Bend guard
laws and four negative mutations pass. See `docs/batch-settlement.md` for the
execution contract and commands.

The independent Rust batch implementation now passes the same seven real-token
conformance tests. The matched benchmark covers 18 operations, compares all input
fixtures and post-state/error outputs, repeats identically, and records source and
toolchain hashes. Current settlement cost is about 2.00–2.06 times Rust; see
`docs/batch-benchmark.md`. The universal batch verifier now passes all 788
obligations and seven source mutations with symbolic counterexamples and concrete
Bend replays. Fourteen arithmetic-binding negatives and three protocol-schema
negatives guard the compositional proof. Its source/model hashes are current.

The complete 15-command refinement suite now passes. All five application build
manifests are current, and the three earlier public builds reproduce their test
binaries, interfaces and manifests in fresh output directories.

The final runtime regression passed with 68 tests, zero failures and two explicit
benchmarks ignored by the default test command. The required batch benchmark was
run separately. All eight requirements passed the
[requirement-by-requirement acceptance audit](containers-acceptance-audit.md).
