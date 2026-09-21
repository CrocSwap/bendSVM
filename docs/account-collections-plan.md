# Account-backed collections milestone

Status: accepted. Fresh implementation, proof, runtime and benchmark evidence
passed the [requirement-by-requirement audit](account-collections-acceptance.md).
The accepted container milestone remains separate historical evidence.

## Objective

Let developers safely manipulate larger account-backed collections through reusable
Bend APIs, with clear target diagnostics, source-level invariants and an equivalent
Rust benchmark.

## Storage contract and implementation direction

Keep small application state separate from a program-owned collection account.
The collection has a versioned, schema-bound header, a logical length, and a
capacity derived from its allocation and fixed canonical element width. Capacity
must not require materializing all elements in a Bend value. Existing native and
wire limits continue to apply to each per-call value.

A checked Bend selection function chooses a bounded contiguous window using
context, state, instruction and collection metadata. The shared adapter validates
the range, loads only its active records, and invokes the checked transition with
that window. The transition returns small state, updated records, logical length
and optional effects. The adapter validates and encodes the complete proposed
update before effects or writes; successful execution commits only the selected
records and metadata. No application names may appear in compiler/runtime logic.

Contiguous windows are the initial interface: callers can process an arbitrary
index by choosing a single-element window. Windows may extend past logical length
for append, but never past physical capacity. Appends must initialize every newly
active record without holes. Deletion/truncation semantics must be explicitly
specified before being exposed; the initial interface need not permit truncation.
Inactive allocated bytes do not become typed values until written canonically.

Reject malformed headers, incompatible element schemas, invalid logical lengths,
invalid active records, out-of-range windows, overflowed byte offsets, unauthorized
accounts, writable aliases, and updates outside the selected window. The source
application binds the collection account to its state so another valid collection
cannot be substituted. Untouched record bytes remain unchanged. Initialization
may scan an allocation, but ordinary access must scale with the selected window.

The exact ABI descriptor and account ordering will be specified alongside the
adapter. Selection and transition roots must both enter the checked build and
manifest. Generated clients must use the same descriptor and canonical codecs.

## Acceptance requirements

| Requirement | Required evidence |
| --- | --- |
| Reusable Bend API | Generic metadata/window/access/update/append operations; two independent element types and capacities; no application-specific compiler branches |
| Large account storage | Real SBF accesses to collections larger than the 1,024-byte value limit; bounded per-call decoding/writes; unchanged bytes outside the window |
| Safety contract | Header/schema/size/length/range/overflow/ownership/alias negatives, exact append behavior and failed-transaction rollback |
| Developer diagnostics | Stable target error codes, meaningful context and remedies for unsupported forms/resource limits; tested CLI failures and documented compatibility |
| Source invariants | Checked-source contracts for range/access/update/append and application conservation/progress/replay; source binding and mutation counterexamples |
| Acceptance application | Paged token settlement queue with many obligations, bounded work across multiple transactions, exact custody/recipient binding and late-effect rollback |
| Independent Rust baseline | Independent implementation of identical protocol, storage and errors; shared conformance fixtures |
| Benchmark | Matched successful and rejected operations, multiple collection sizes/windows, exact results, repeatable CU/ELF measurements and input/toolchain hashes |
| Regression and workflow | Existing applications preserved, build/client documentation, current complete tests/refinements and requirement-by-requirement evidence audit |

Source invariants are not an end-to-end proof of the compiled binary. Explicitly
record which adapter/arithmetic contracts are proved and which are tested.

## Sequence

1. Implement overflow-safe range and typed window operations with differential tests.
2. Implement the versioned account layout, selection/transition ABI and client.
3. Exercise the shared adapter with independent element types and hostile accounts.
4. Add actionable target diagnostics and source contracts for collection operations.
5. Build the paged settlement application, laws, refinement and runtime tests.
6. Build the independent Rust baseline, matched benchmark and final evidence audit.

## Incremental evidence

`sdk/collection.bend` now provides metadata, bounded read/reservation ranges,
generic window reads/updates using global indices and bounded local appends.
Reservations reject gaps before an
append; they do not themselves write records or change the account length.

`npm run test:collection` passes 860 independent-oracle/Bend/native-sanitizer/SBF
cases, including invalid metadata, empty windows, U32 boundary arithmetic and
two element types/backing capacities. The current pure fixture is 8,632 ELF bytes
and uses at most 341 CU in these cases. This is not an account-storage benchmark.

`npm run verify:collection` proves nine source-model claims over arbitrary U32
metadata/indices and arbitrary element values, including nonwrapping interval
selection, exact global-index reads, updates preserving other elements, and
appends preserving the prefix and window origin. Five checked source mutations produce
counterexamples: wrapped ranges, reads of inactive records, reservation holes and
underflowed global indices and lost window origins. Reports include source hashes. These checks are now
included in the runtime and refinement suite entry points. The complete
17-command refinement suite and complete runtime suite pass.

`runtime/bend_collection_runtime.h` implements the shared account-byte substrate: a 56-byte
header (20-byte schema identity, U32 length, 32-byte owning state address), capacity
derived from allocation, nonmutating validation, bounded record lookup, append
preflight and commit. Native ASan/UBSan tests exercise capacities 0/1/16/4096 and
strides 1/4/37, rejected metadata/owners/flags/bindings/overflow, real sequential
appends and preservation of bytes outside update windows. The generated adapter
validates canonical elements, account aliases, source outcomes and effects, and
calls preflight before commit. The low-level commit trusts those
preconditions; it is not a safe application-facing primitive.

The generated ABI-3 adapter and descriptor-based client now build a U32 storage
fixture. Its two real-account SBF tests pass: 300 appends into a 16,440-byte account,
distant-index replacement with unchanged bytes outside each record, full-capacity
rejection, bad index/mode/schema/binding/length/owner/size/read-only/alias rejection,
and unchanged managed accounts on rejection. The fixture intentionally supplies
no application authorization policy and is not a deployable application.

The independent record fixture uses a four-slot window and a Bool/U32 record in
a 12,344-byte account. Its SBF test passes 200 appends, distant replacements,
rejection of malformed selected tags/Booleans, preservation of unrelated malformed
records and overwrite of inactive bytes on append. The U32 fixture also returns
deliberately invalid accepted outcomes: shifted origin, removed loaded records,
and increased length without initialized entries. All three are rejected without
changing managed accounts. Additional SBF tests cover initialization and generic
CPI permissions, managed-account aliases and rollback, alongside the pure fixture.

Target diagnostics now provide stable categories, corrective hints and function
context for backend failures, plus wire-size and collection-ABI errors. CLI tests
check nonzero status, diagnostics and absence of an ELF after unsupported source.
See [diagnostics.md](diagnostics.md) for coverage and remaining limitations;
native and wire value reports, Clang stack reports, and oversized value/frame diagnostics are now implemented. Source spans remain a future tooling improvement.

The adapter structurally checks selection and transition signatures, loads only
active selected elements and pre-encodes proposed writes. Optional token/CPI
effects are emitted. The new [queue application](queue-settlement.md) now exercises
real token effects and late-CPI rollback: four SBF tests cover a 65-obligation
funded lifecycle, bindings, conservation rejection, full-U64 overflow and atomic
failures. Six checked source laws and four law mutations pass. The queue client
also exposed and fixed rejection of the supported token-v2 effect descriptor.

The queue's universal source refinement now passes 428 claims with seven mutation
counterexamples/Bend replays, 18 arithmetic binding negatives and three protocol
schema negatives. The independent Rust baseline passes shared conformance, and
26 benchmark operations have identical fixtures/outcomes/errors and repeatable
costs. Measured settlement costs are about 2.28–2.45 times Rust; bounded page costs
stay constant across the tested larger capacities.

Collection CPI permission/managed-alias/rollback tests and initialization signer/dirty-allocation/reinitialization tests now pass. Native/wire layout and Clang stack reports are emitted and included in public build manifests, with tested resource diagnostics.

Fresh builds reproduce all artifacts and manifests for the three collection
fixtures and queue, including native/wire and stack reports. The complete
17-command refinement suite passes, with report and source hashes verified. The
refreshed 26-operation benchmark passes with current manifests and resource
reports. The complete runtime regression passes with 78 tests, zero failures and
three benchmark-only tests ignored by the normal runner. The final evidence audit
passes and records current source/artifact hashes in
`build/account-collections-acceptance.json`.
