# ABI 1 adapter assurance plan

The ABI 1 adapter connects a checked Bend transition to Solana account bytes.
This document states the contract to verify and the evidence currently available.
Its main contract concerns the single-state adapter in `compiler/storage.ts`.
The ABI 2 multi-state contract and restricted emitted-C check are documented
below. ABI 3 collection semantics remain an implementation target.

## Contract

Let `H` be the generated 20-byte state header, `n` the canonical state size,
and `m` the canonical instruction size. The Solana loader is assumed to provide
a valid aligned invocation buffer and truthful account metadata. The adapter
does not establish that loader property itself: `runtime/solana_min.h` uses the
loader-provided account lengths to advance through the buffer.

For a call without effects, the accounts must be exactly `[state, actor]`.
For an effectful call, the account count must be 4–12. All account keys must be
distinct. The state account must be owned by this program, writable,
nonexecutable, and exactly `20 + n` bytes. The instruction must be exactly
`1 + m` bytes with mode 0 or 1 and a canonical payload. Mode 0 additionally
requires the state address to sign and its complete allocation to be zero;
the all-zero payload must decode as a state. Mode 1 requires header `H` and a
canonical stored state. Effectful calls require account 3 to be the custody
PDA derived from this program and the state key (error 11); token calls require
account 2 to be the executable original SPL Token program (error 10). Custody
setup is checked after instruction length/mode and before state owner/flags.
The actor key and signer flag come from the runtime account, and the slot comes
from the Clock syscall. Application authorization
is the checked Bend transition's responsibility.

After these checks, the adapter calls the Bend root once. `Rejected{code}`
returns `256 + code` for codes up to `0xfffffeff`, otherwise error 9. A root
result with an unexpected tag, or a state that cannot be encoded, returns error
9. For `Accepted{state}`, the adapter first encodes the complete next state
into local bytes. If effects are present, it extracts them, validates every
slot before the first execution, and executes slots in order. For arbitrary
CPI, an active effect that requests the managed state account (index 0) writable
rejects with error 22. In ABI 1 this guard precedes returning the same slot's
helper validation error, so 22 takes precedence when both conditions fail.
Only after all executions succeed does it write `H || encoded(state)` to the state account,
set return data to `encoded(state)`, and return success.

On every explicit nonzero return path, the adapter itself has not committed
state bytes. This excludes runtime aborts: compute exhaustion can occur between
the two commit copies or after them. An earlier CPI may already have changed
other accounts. Reverting partial writes on abort, restoring those other
accounts, and rolling back a preceding account-creation instruction all rely
on Solana transaction atomicity. A helper failure returned to C maps to error
18, but a real CPI failure may abort without returning control to this branch. This distinction is part of
the contract, not a property of the C adapter alone.

## Trace to generated C

`emitSingleStorage` in `compiler/storage.ts` checks account count and duplicate
keys, checks instruction length/mode and custody setup, validates state
owner/flags/size, decodes the selected state mode and
instruction, constructs context from the actor and Clock, calls the Bend root,
encodes acceptance, validates effects, executes effects, then copies the header
and payload and sets return data. The account parser and key comparison are in
`runtime/solana_min.h`; canonical decoders and encoders come from
`compiler/codecs.ts`; token and arbitrary-CPI validation/execution are emitted
from `compiler/effects.ts` and implemented by runtime headers.

`npm run test:adapter-template` regenerates ABI 1 C for pure, token-effect and
arbitrary-CPI fixtures, ABI 2 C for pure and token-effect fixtures, and ABI 3 C
for pure and arbitrary-CPI fixtures. It checks critical control-flow stages,
including collection open/select/plan/commit, and ABI 2 binding checks/writes
appear in order; guard, decoder, effect, commit and binding mutations must fail
the audit.
Existing SBF tests exercise signed initialization, malformed accounts,
alias rejection, token and CPI permissions, and rollback. These are regression
checks of emitted text and selected executions. They are **not** a proof of
C control flow, C defined behavior, Clang/LLD, SBF, or Solana runtime semantics.

`npm run verify:account-key` audits the exact `equal_key` implementation in
`runtime/solana_min.h` and proves with Z3 that its four eight-byte comparisons
agree with equality of all 32 bytes, for either byte order. A shortened
three-chunk loop must yield a counterexample. The claim assumes readable
buffers, 64-bit `u64`, and exact `memcpy` semantics; it does not verify C
compilation or the SBF binary. Its report is `build/account-key-refinement.json`.
The ABI 2 secondary binding guard calls this same helper on its stored 32-byte
primary key and the loaded primary account key; the generated-template audit
checks the guard appears before the Bend transition.

`npm run verify:codec-primitives` audits the exact generated U32, Bool and
bounded Nat C codec templates and checks their byte packing, roundtrip and
range guards with Z3 bitvectors. Wrong high-byte, Bool-bound and Nat-bound
models must produce counterexamples. The report is
`build/codec-primitives-refinement.json`. That scalar command does not establish
ADT correctness or C-to-SBF preservation. `verify:codec-structures` now adds
restricted generated-C conformance and compositional layout checks for recorded
ADT instances, plus separate native/SBF wire execution matrices. See
[canonical codec assurance](codec-assurance.md) for the precise boundary.

## Semantic adapter execution harness

`npm run test:adapter-semantics` emits ABI 1 pure, two-slot token, three-slot
token and single/paired two-slot arbitrary-CPI fixtures. Host Clang compiles the actual
adapter and generated headers with AddressSanitizer and UndefinedBehaviorSanitizer.
A native harness constructs loader invocation buffers and compares execution
with an independent TypeScript contract oracle. It checks account validation,
canonical decoding, actor/clock context, root call order, rejection mapping,
local encoding, effect validation/execution order, exact commit and return
bytes, and absence of adapter state writes on errors. Deliberate compiled C
mutations must violate the oracle or its independent trace/commit invariants.

The harness uses the real account loader parser, emitted codecs, Bend root and
effect extraction, with wrappers for selected failures. Clock, return-data and
effect helper boundaries are mocked. It proves no claim about the actual token
or CPI helper implementations, syscall behavior, transaction rollback or SBF
compilation. Earlier mocked effects may have executed on a failed call; only
the adapter’s own commit is checked. Decoder wrappers initialize local outputs,
and ASan/UBSan do not establish absence of all uninitialized reads.

The matrix uses position-dependent key bytes, owner differences in all four
eight-byte chunks, every alias-marker position and equal-key pair at sampled
account counts, and helper errors with zero low 32 bits. Both CPI slots can be
active through the checked Bend paired-CPI fixture. A scripted root result
exchanges the slots of the single-CPI fixture to isolate the writable-state
rejection on slot 1; this particular case is adapter evidence with injected
root output, not an end-to-end Bend case.

Ordinary mutants must complete the matrix and disagree with the oracle or an
invariant. Only removing the account-count upper bound permits an abnormal
exit: the run must match through every preceding scenario and stop at the
first excessive count, with an ASan write into the element just beyond the
`accounts` array. The required ASan stack-frame description can vary with
compiler/platform; an unrecognized diagnostic fails the gate. A timeout,
unrelated crash or incomplete normal-mutant run does not count as a detected
semantic fault. The lower-bound mutant is a separate, completed contract
mismatch for effectful adapters.

The oracle pins the current precedence when multiple guards fail; a harmless
change in error precedence can therefore require updating the test. The focused run passed 22,695 scenarios across five fixtures and rejected 220
compiled mutations (215 contract/invariant mismatches and five specifically
checked ASan overflows). Results and source hashes are in
`build/adapter-semantics/report.json`. This is finite
semantic regression evidence, stronger than the text-order audit, and remains
separate from the symbolic artifact check below.

## Helper assumptions for the state-preservation argument

The loader must provide truthful metadata and valid, aligned, disjoint account
regions. Stack locals, `encoded`, the header and account regions must not alias.
The checked root and codec calls must respect their local-buffer contracts.
The proof of explicit adapter writes cannot by itself establish these facts.

For ABI 1 token effects, validated source/destination/mint indices start at 4;
the authority is the actor or custody account. These instruction metas exclude
state index 0. General CPI can include state index 0 read-only. The adapter's
error-22 guard excludes writable metas for that account. Both execute helpers
supply an account-info array that still marks the outer state writable; **the
instruction metas and runtime privilege enforcement provide the restriction**.
The argument assumes CPI writes and runtime writeback affect only the permitted
account regions, preserve caller stack buffers, and do not change the state
account's data, owner, length or lamports. It also assumes the final return-data
syscall behaves as specified for the admitted payload size.

Read-only forwarding exposes pre-transition state and may forward a signer
capability when the caller supplied that signature and the meta requests it.
Read-only status does not remove a signature. Applications must authorize their
CPI capabilities in Bend; the executor fixture accepts caller-selected effects.

All effect validation runs against the **pre-effect snapshot**. Earlier token
effects can change balances, supply or destination contents before a later
execution. Thus an initialization/fresh-destination check is not a guarantee
that its predicate still holds at each later leg. Executions remain fallible;
the target program and transaction rollback are separate enforcement layers.
Only immutable metadata conditions and the state-region exclusion can be
carried across effects under the stated assumptions. The native semantic
harness mocks these boundaries; its successful traces do not prove the real
helpers' or runtime's preservation properties.

## Token helper contract

The helpers in `runtime/token.h` require valid native objects and 4–12 outer
accounts, readable key/owner pointers, and account data readable for the reported
length. The adapter establishes the count and distinct account keys; loader
metadata and disjoint storage remain assumptions. These helpers do not establish
application authorization or relationships between protocol records.

`bend_custody` first requires account 2 to be the executable original SPL Token
program (10), then derives `[bend, primary_state_key]` under the current program
and compares the result with account 3 (11). A failed derivation may modify its
bump output; execution requires successful setup.

`bend_transfer_validate` is read-only. Its active kinds are none (0), transfer
(1), mint check (2), mint (3) and burn (4). None ignores the other fields. Every
other kind first checks the mint index, token-program ownership, nonexecutable
status, exact 82-byte initialized mint layout and expected mint key. Mint check
then succeeds without checking transfer/issuance fields. Unknown kinds reject
after those common mint checks.

- Transfer requires distinct source/destination/mint indices at least 4,
  writable token accounts owned by the token program, exact 165-byte layouts,
  initialized or frozen state, nonnative accounts, and matching mints. Optional
  source/destination bindings compare full account keys. Fresh destination
  requires zero balance, no delegate or close authority, and custody ownership.
  Source authority is a signing actor or custody; destination owner is the
  actor, custody, or explicit recipient key.
- Mint and burn require a writable mint exclusively controlled by custody,
  with no freeze authority. Their selected token account must be writable,
  correctly owned and laid out, nonnative, and bound to that mint. Mint checks
  its recipient and Boolean initialization flag; requested initialization also
  requires zero supply. Burn requires a signing actor owning its source.

The token program remains authoritative for balances, frozen-state behavior,
arithmetic and other token restrictions. Validation success alone does not
promise that execution will succeed. All slots validate before any executes;
mutable predicates such as zero supply or fresh destination need not remain true
after earlier legs.

`bend_transfer_execute` assumes successful extraction, custody and validation.
It builds TransferChecked, MintToChecked or BurnChecked, preserving the u64
amount and reading decimals from the mint. It forwards account-info pointers,
sizes, rent epochs and normalized flags, and returns the full syscall error.
It performs no local account mutation or size refresh. Other active kinds do
not invoke. Writes by the token program and rollback are runtime obligations.

**Extraction is part of the executor precondition.** The executor chooses PDA
signer seeds from `authority`, including for mint/burn; the validator does not
check that field for those two kinds. The extractor explicitly sets mint
authority to 1 and leaves burn authority zero through initialization. Arbitrary
native structures accepted by the validator are therefore insufficient to
establish the executor's intended signing behavior. Existing extraction evidence
and separate helper checks must not be described as a composed proof.

### Native token-helper evidence

`npm run test:token-helpers` compiles the actual runtime headers under host
ASan/UBSan and compares program recognition, custody setup, validation and
execution with an independent TypeScript oracle. Only PDA derivation and the
invoke syscall are mocked. Executor cases satisfy the independently checked
validation and extraction preconditions. The harness observes raw syscall
counts before bounding its inspection to initialized entries, exact token
instruction bytes/metas/seeds, forwarded account-info fields, full-width errors,
and preservation of effect bytes and account contents/metadata/pointers.

The host-integrated gate passed 171 cases and 28 compiled faulty helpers, each
faulty helper completing the entire matrix with an ordinary contract mismatch.
Two separate, exactly allocated short-buffer probes require a one-byte ASan
heap-buffer-overflow in the validator when mint/token reads move before their
size guards; unrelated crashes and timeouts do not count. These diagnostics
and input hashes are retained in `build/token-helpers-native/report.json`.
Ordinary cases have 165-byte backing buffers and therefore do not establish
physical read safety for arbitrary reported lengths. Helper-only acceptance
cases, including noncanonical mint/burn authority and count 13, never establish
executor preconditions. This is finite native evidence, not a formal executor,
token-program, transaction-rollback or SBF preservation proof.

### Symbolic token-validator evidence

`npm run verify:token-validator` interprets the actual live validator body with
symbolic U32 flags/indices, U64 sizes and arbitrary data/key bytes. Its three
claims cover 130 guarded read obligations, exact error/success behavior and
exclusive return coverage. Nineteen SAT witnesses exercise all active kinds,
all returned errors, and mint/burn acceptance of noncanonical authority. Full
solver models are recorded. Sixty faulty source artifacts must reject (34
semantic counterexamples and 26 syntax/dependency failures); five equivalent
rewrites must pass. Two read-before-size variants fail only the read-bounds
claim, preserving return behavior.

Independent review exposed a genuine dependency-binding flaw in the initial
checker: Clang overloads could redirect data-key comparisons while the model
still used the audited helper. The shared header audit now rejects both GNU
and bracket attribute overload forms. Token and CPI gates require unique
file-scope bindings for summarized functions across the include closure.
Permanent probes cover all three token headers and both attribute spellings.
Account elements and account pointers also have distinct interpreter roles.

The host replayed 120 solver-generated cases against compiled native C under
ASan/UBSan, with no mismatches. That finite cross-check is retained under
`build/token-validator-review-host/`; it is separate from the routine symbolic
gate. The parser/interpreter, declared policy, native layouts, helper summaries,
readable input objects and Z3 remain trusted. The contract intentionally pins
current error precedence; it does not prove the policy is sufficient for every
application. Valid custody setup establishes the meaning of accounts 2 and 3.
No executor, syscall, compiler or composed adapter theorem is claimed.

## Arbitrary CPI helper contract

The three helpers in `runtime/bend_cpi.h` have different obligations. They require
valid native objects, readable 32-byte keys and 4–12 outer accounts. Application
authorization, account identity relationships and disjoint loader buffers remain
caller/loader obligations.

- **Custody setup:** derive with the four bytes `bend` and the primary state key
  under this program id; require the result to match account 3. Derivation error
  or key mismatch returns 11. The bump output is meaningful for execution only
  after successful setup; failure does not promise an unchanged bump.
- **Validation:** an inactive effect returns success without inspecting its
  other fields. Every nonzero native `active` value takes the active path (the
  checked source/extractor normally supplies 0 or 1). The target index must be
  at least 2 and below the outer count, executable, and match its expected key
  (error 19). Payload length is at most 64, meta count at most 8, and all bytes
  after the payload length are zero (20). Every active meta has a valid index,
  matching key, Boolean permission flags, no writable/signature escalation, and
  a distinct index (21). Account 3 may request the custody signature without
  an outer transaction signature. Unused meta slots are ignored. Validation
  performs no syscall or input mutation.
- **Execution:** for an active effect whose validation and custody setup
  succeeded, preserve meta order, target, data and requested permissions in
  the syscall. Forward the outer accounts' keys, owner/data/lamport pointers,
  sizes, rent epochs and normalized Boolean flags. Pass custody signer seeds
  `[bend, primary_state_key, bump]` iff an active meta requests account 3 as
  signer. Return a nonzero syscall error at full u64 width. On explicit success,
  refresh every local `Account.size` from the syscall's updated account-info
  length; on explicit error perform no such refresh. Inactive effects do not
  invoke or refresh. Other local account fields and the effect remain unchanged
  by the helper; writes performed by the syscall are a separate runtime contract.

Validation happens before **all** executions. Index/key/privilege assumptions
must remain valid across earlier effects; mutable data and balances can change.
The executor is not a second validator, and native malformed values or stale
pointers cannot be passed to it on the strength of a prior unrelated validation.
A syscall abort need not return through the explicit error branch. Transaction
rollback remains necessary.

The helper accepts a writable meta for state index 0 if the outer account is
writable. **Managed-state exclusion is enforced by the adapter, not this
helper.** Read-only metas may retain explicitly requested signer capabilities.
Neither this helper nor a proof of it supplies application authorization.

### Symbolic validator evidence

`npm run verify:cpi-validator` reads the real runtime headers, pins the relevant
live file-scope declarations and `equal_key` body, and parses the validator's
live body. A separate declaration of the capability contract supplies the
expected return code. The interpreter models short-circuit conditions, U32
comparisons, scoped meta pointers and bounded loops; every indexed read and
loop continuation receives a path condition. Z3 checks read bounds/termination,
exact return behavior, and exactly one return for every admitted input.
Only read-only statements and the audited pure key comparison are permitted.
The include-closure audit rejects alternate attribute/overload spellings and
requires a unique file-scope `equal_key` binding, including dependency headers.

The report `build/cpi-validator-refinement.json` records input hashes, symbolic
claims, nonvacuity witnesses, rejected source mutations and accepted equivalent
rewrites. A witness explicitly shows that the helper alone accepts writable
state forwarding. Decoy function bodies in comments or string literals cannot
supply the parsed implementation. This gate is separate from the ABI 1
entrypoint gate; the latter still abstracts helper calls rather than composing
this model into each adapter proof.

The parser/interpreter, exact declaration bridge, 8/32/64-bit widths, native
layout, readable key buffers, `memcpy` semantics and Z3 remain trusted. The
key helper is summarized as equality of 32 bytes under those assumptions.
The including translation unit, earlier generated headers and command line must
introduce no interfering macros or layout controls, and include resolution must
select these exact runtime headers. This standalone gate does not establish
those facts for each compiled adapter.
This is not general C verification, an executor/syscall proof, or a proof of
Clang/LLVM/SBF preservation.

### Native custody, validation and execution evidence

`npm run test:cpi-helpers` compiles intact runtime-header copies under host
ASan/UBSan. Only PDA derivation and `sol_invoke_signed_c` are mocked. An independent
TypeScript oracle compares return codes, input/account preservation, seeds,
program/data/meta order and keys, outer account-info pointers and normalized
flags, full-width syscall errors, and account-length refresh on success versus
explicit failure. Two-call cases check refreshed lengths reaching the next CPI.
Validation cases poison account data buffers, which this metadata-only validator
must not read. Writable state index 0 is deliberately accepted by the helper
alone, documenting the caller's separate obligation.

The host run passed 101 cases (11 custody, 67 validation, 23 execution) and
rejected 43 compiled mutations. Every mutant completed the full matrix with an
ordinary contract mismatch; crashes, timeouts and partial output cannot count
as detected mutations. Executor inputs are valid under the baseline contract;
mutated prerequisite checks may report a failure, which is recorded while the
matrix continues on those baseline-valid inputs. A spare account slot permits
selected logical count-bound mutants to complete safely; it is not evidence of
physical access safety for arbitrary invalid indices.

Mock inspection is bounded, while raw syscall account/meta/signer counts are
recorded separately. Oversized or negative scalar arguments cannot be hidden by
clamping the observation. A host-added mutation reproduced that observation gap
before the fix. The test checks tested-file hashes before publication, removes
the conventional success report at the start of a new run, and writes a new
report only after every case and mutation completes. Evidence is
`build/cpi-helpers-native/report.json`; the test is registered in `npm test`.

This is finite native execution evidence with deterministic syscall responses.
It does not establish PDA cryptography, real syscall semantics, runtime writeback
or rollback, SBF compilation, or formal executor correctness. The symbolic
validator gate above and compiled-SBF regression below remain separate evidence.

## Compiled CPI state-frame regression

`npm run test:cpi-frame` builds the existing checked `tests/cpi.bend` executor
and a test-only observing callee. Then run:

```sh
cargo test --locked --test sbf cpi_frame -- --nocapture
```

Three tests passed on pinned LiteSVM 0.7.1 with its default features:

- A read-only state meta exposes the old state to the callee; the adapter
  subsequently commits the encoded next state. During signed initialization,
  the state signature reaches the callee only when that meta requests it.
  Requesting an unavailable state signature on transition rejects with 21.
- After writing its own receipt, the callee attempts to write the forwarded
  state. The runtime reports `ReadonlyDataModified` and restores the state,
  receipt and other involved accounts. A control write to a writable
  foreign-owned account reports `ExternalAccountDataModified` instead.
- A writable state meta rejects with adapter error 22 before a callee invoke
  log or receipt appears, in initialization and transition and at different
  meta positions.

The rollback snapshot excludes the fee payer. These tests do not attempt
lamport/owner mutation, self-CPI, or alternative validator feature sets; exact
runtime error presentation may differ there. Build/source hashes are recorded
in `build/cpi-frame-report.json`; that file records a build, not a successful
Rust test run. The test log supplies the execution result. Both fixture
construction and these Rust tests are included in `npm test`.

## Effect extraction contract

Extraction marshals a checked native Bend effects value into the fixed runtime
slot structures consumed by validation and execution. It does not authorize
an operation or invoke a program. Its contract has three separate parts:

- **Frame:** the source value is unchanged; writes stay within the declared
  output slots. Source and destination objects must be valid, aligned and
  disjoint. A failure may partially modify these temporary slots; the caller
  must discard them and must not execute any effects.
- **Initialization:** successful extraction initializes every scalar and byte
  field of every slot, including inactive slots and fields unused by a variant.
  Struct padding is not part of the semantic output contract.
- **Mapping:** for well-formed native values, each output field comes from the
  prescribed source field, keys/data use little-endian U32 limbs, and amounts
  equal `lo | (hi << 32)` with the shift performed in 64 bits.

| Source variant | Runtime active code | Additional mapping |
| --- | --- | --- |
| Token None | 0 | All output fields zero |
| Token Transfer | 1 | Indices, mint/recipient keys, authority, amount |
| Token CheckMint | 2 | Mint index and key; other fields zero |
| Token Mint | 3 | Custody authority, destination, mint, recipient, amount, initialize |
| Token Burn | 4 | Source, mint and amount |
| Token BoundTransfer | 1 | Transfer plus source/destination binding flags and keys, freshness |
| CPI None | 0 | All output fields zero |
| CPI Invoke | 1 | Program index/key, length/count, all 64 data bytes and all eight metas |

Token authority tags are Actor=0 and Custody=1; recipient tags are
ToActor=0, ToCustody=1 and ToOwner=2. Binding tags are Any=0 and Exact=1.
Fixed records traverse their declared slots in order and propagate failure.
Bounded vectors require valid record tags and length at most capacity; only
the active prefix is extracted, and every remaining slot is zeroed.

CPI extraction copies length, count, indices and flags. Permission checks,
length/count bounds, canonical data tails and account identity checks remain
in the validation helper. Extraction success alone does not mean a CPI or
token operation is authorized or executable. Likewise, well-formed native
values are a precondition of the semantic mapping, not a claim that every
malformed in-memory value is validated by extraction.

### Evidence for extraction

`verification/effect_extraction.py` checks the actual extraction helper text
against field mappings derived from the recorded schema and interface. Its
restricted parser enumerates constructor, enum, guard and active-length paths;
it permits only bounded output writes, checks initialization and compares each
successful path with the independent mapping. It audits the relevant native
and runtime declarations and `write_le`, including dependency macros and include
forms. Audited definitions must occur at file scope in live header tokens;
macro replacement lists cannot supply decoy definitions, and only integer
object macros and the existing noinline attribute are admitted. Header hashes
are recorded; reported slot offsets are derived under natural alignment.
This is a reviewed structural checker, not a mechanized proof of C
semantics. It assumes valid aligned, disjoint native input and output objects,
well-formed native values, and compilation without external macro interference.

The ABI 1 gate runs this subcheck for its twelve emitted fixtures and checks
faulty extraction artifacts as part of its mutation suite. It also runs
`verification/effect_extraction_probes.py`: twelve positive fixtures, nine
accepted equivalent rewrites and 148 rejected mutations. Two of these probe
fixtures are synthetic vector layouts of capacities two and eight; they are
checker tests, not evidence that every such schema fits the compiler's bounds.
The report records the probe report's hash and separates extraction results
from the entrypoint's symbolic claims.

`npm run test:effect-extraction` independently executes the written helpers
under host ASan/UBSan against a value-level oracle, checking every output field,
input preservation and output guards. Nine real emitted fixtures cover fixed
token-v1/token-v2/CPI slots, token-v1 vectors of capacities two/four/eight and
token-v2 vectors of capacities two/four. Unsupported or oversized shapes must
reject through the ordinary compiler. The test also runs compiled helper
mutations, requiring mismatches and specific sanitizer failures. Its evidence
is `build/effect-extraction-native/report.json`; it is registered in `npm test`.
These are finite native tests, not SBF execution or a proof over all inputs.

## Symbolic check of emitted ABI 1 adapters

`npm run verify:adapter-contract` regenerates twelve ABI 1 fixtures, reads the
written C and its include closure, parses the complete entrypoint with a
restricted C grammar, and symbolically executes its branches, bounded loops,
integer operations and boundary calls. Z3 checks ten claims against a separate
contract: commit only on success, root preconditions and exact inputs, effect
ordering, success/failure equivalence, error attribution, exact committed and
returned bytes, rejection mapping, helper-code width, and pinned return/trace
precedence. The driver also requires reachability witnesses, counterexamples to
false assertions, rejection of deliberately mutated artifacts for the expected
reason, and acceptance of behavior-preserving rewrites.

This is a check of the twelve recorded artifacts, **not every possible emitted
adapter and not an automatic build-time certificate**. It covers pure, token,
CPI, issuance and four-slot effect-vector fixtures, plus the five ABI 1 example
applications. ABI 2 and ABI 3 are outside this gate. The restricted parser,
symbolic executor and call summaries remain trusted code; this is not a
machine-checked proof of their correctness or a complete C semantics.

The abstract contract treats codec success/canonicality, root results, custody
setup, extraction, validation and execution as opaque predicates or results.
In particular `SETUP == 0` stands for custody/PDA and token-program checks;
their implementations are not proved here. Codec evidence is separate: this
gate does not establish that a codec-proof receipt covers these exact fixtures.
The root must be pure. Helpers must preserve adapter locals, state data and
return data except for their specified outputs. The extraction subcheck addresses
frame, initialization and field mapping
under its native-value preconditions; its parser and schema-to-C bridge remain
trusted. Preservation of those native-value invariants by the Bend lowering is
not proved. The entrypoint interpreter still overapproximates extraction outputs
with uninterpreted symbols. Runtime aborts and external effects
still depend on transaction rollback.

The exact bodies of `read_le`, `read_account` and `equal_key` are audited against
reviewed text. The loader supplies valid aligned buffers, truthful lengths and
metadata, and valid pointer ranges. Compilation must not introduce conflicting
macro definitions. Clang/LLVM/LLD and SBF execution remain outside the proof.
Account, key and helper values otherwise range symbolically over their modeled
widths; this is broader than enumerating a finite set of transaction inputs.

The precedence model below is pinned from `compiler/storage.ts`. It is a
regression contract in addition to the general safety properties. Each row is
reached only after earlier rows succeed:

| Stage | Explicit return on failure |
| --- | --- |
| Account count | 1 |
| Account parser/duplicate key checks | 6 |
| Instruction length/mode | 2 |
| Custody setup, for effectful adapters | Full-width helper code |
| State owner/executable, writable, size | 3, 5, 4 respectively |
| Initialization signer then zero allocation, or transition header | 7 then 4, or 4 |
| State decode then instruction decode | 4 then 2 |
| Clock syscall | 8 |
| Root rejection or unknown tag | 256 + bounded code, or 9 |
| State encode then effect extraction | 9 |
| Each slot's writable-state CPI guard then validation | 22 then full-width helper code |
| Each slot's execution | 18 if control returns with a failure |
| Commit header/payload and return encoded payload | 0 |

All validation slots precede all execution slots. Commit writes may commute:
the gate checks their final bytes and absence of fallible calls after commit,
not header-before-payload as a separate property. Runtime aborts during either
copy are covered only by the rollback assumption.

`tests/adapter-interpreter.py` exercises the checker's own failure modes,
including lost paths, overlapping writes and post-write reads, uninitialized
helper outputs, repeated encoding, and parser ambiguities. A wrong-length encode
leaves its destination untouched; repeated valid-size encoding into the same
buffer is explicitly outside the model. It runs before fixture verification. Total coverage and mutual
exclusion of completed symbolic paths are mandatory. Unsupported syntax,
solver unknown/timeout, a crashed worker, or a missing result fails the gate.
Only a fully validated report is published at
`build/adapter-contract-refinement.json`; its hashes delimit the evidence.

## Proof sequence

1. Specify canonical values and byte slices. Prove generated codec roundtrip,
   canonical rejection, and exact buffer bounds for every admitted schema.
2. The ABI 1 artifact gate now supplies a restricted symbolic model with an effect
   trace. Prove that success implies all checks and executions succeeded, the
   committed bytes and return data have the stated values, and an adapter
   error before commit performs no adapter state write.
3. Strengthen the trusted parser/summaries into a mechanically checked representation
   and control-flow relation, or validate each generated adapter against the
   model at build time. Deliberate emitter mutations must yield failed checks.
4. Extend that argument to ABI 2/3, effect helpers and CPI permissions. Keep
   loader metadata, syscalls, external programs and transaction rollback as
   explicit assumptions until independently verified.

Only a check tied to the generated implementation can support a compiler
assurance claim. Proving a separate abstract protocol would establish the
contract's consistency, but not that emitted C implements it.

## ABI 2 instance binding

For a multi-state record, every field position has a distinct `BDM2` header.
Each secondary account additionally stores the primary state account's public
key between its header and canonical payload. Initialization requires all
managed account addresses to sign and zero allocations; the commit writes the
primary key into every secondary account. A transition rejects a secondary
account whose stored primary key differs from account zero. This prevents
mixing independently initialized instances even when their field types match.
The generated-client decoder requires the expected primary key for secondary
accounts. The template audit requires binding checks before the Bend call and
binding writes after effect execution; deliberate omissions must fail. SBF
tests exercise a mixed-instance rejection and check the binding bytes after
successful commits. This remains runtime and generated-source
evidence, not a formal proof of the ABI 2 adapter.

### ABI 2 entrypoint contract

For a record with `k` fields, `2 <= k <= 4`, field 0 is stored at account 0.
Pure adapters store field `i > 0` at account `i + 1` and require exactly
`k + 1` accounts. Effectful adapters reserve accounts 1–3 for actor, program
and custody, store field `i > 0` at `i + 3`, and require `k + 3` through 12
accounts. Duplicate loader markers and equal account keys reject with 6.
The actor is account 1 in both layouts. The same loader/object-validity and
helper noninterference assumptions as ABI 1 apply to every managed account.

The instruction length and mode checks precede custody setup. Managed fields
are then checked in declaration order: current-program ownership and
nonexecutable status (3), writable status (5), and exact allocation size (4).
Each field has a 20-byte position-specific header; secondary fields additionally
have a 32-byte primary-key binding. Initialization requires the address to sign
(7), the entire allocation to be zero, and a successful decode of the field's
zero payload (4). Transition requires the expected header, the primary-key
binding for secondary fields, and successful field decoding (4). The whole
instruction is decoded only after all fields pass (2); Clock failure returns 8.

The Bend root receives context from the actor/Clock, a record constructed from
the decoded fields in declaration order, and the decoded instruction. Rejection
maps codes through `256 + code` up to `0xfffffeff`, with overflow-range codes and
unexpected outcome tags returning 9. Acceptance first encodes the complete
record for return data, then encodes each field into its own local buffer.
Any encoding or extraction failure returns 9 before any effect or state commit.

Every effect slot is validated before any slot executes. For CPI, a slot's
helper error is returned **before** testing writable managed-state metas;
that order differs from ABI 1. An active CPI requesting any managed account
writable returns 22. Executions run in slot order and an explicit execution
failure maps to 18. Only after all executions succeed does the adapter copy
each field's header, secondary binding and encoded payload, in declaration
order. It then sets return data to the encoded complete record and returns 0.

Required preservation properties are: every explicit error leaves all managed
state bytes unchanged by the adapter; every success commits exactly the
corresponding accepted field bytes to each declared account; every secondary
binding equals account 0's key; and no account outside those commit regions is
written by the adapter. The restricted symbolic gate below checks these
properties for its recorded fixtures. External effects, runtime aborts between commit copies and transaction
rollback remain separate runtime obligations. Component checks must not assume
that separate codec, extraction or helper results have already been composed.

### Symbolic check of emitted ABI 2 adapters

`npm run verify:multi-adapter-contract` generates and reads back nine adapters:
pure, token and CPI, each with two, three and four managed state fields.
`verification/multi_adapter_contract.py` uses the restricted C interpreter and
an independently validated schema/interface contract. The report at
`build/multi-adapter-contract-refinement.json` records exact source, checker,
schema, interface and include-closure hashes. Evidence applies to those inputs.

The accepted focused run establishes 54 UNSAT contract claims and 15,899 guarded
model obligations, with 348 failure-stage reachability witnesses. It rejects
69 mutated artifacts (58 symbolic counterexamples and 11 unsupported-grammar
rejections), and accepts five equivalent variants. These are scoped symbolic
results, not a mechanically verified checker or an end-to-end SBF theorem.

Independent review found false passes in the initial checker for missing
commits with a computed zero return, truncated replies, and wrong helper count
or custody-bump arguments. Permanent regressions now reject those changes;
correct computed-zero returns remain accepted. Every success obligation is
guarded by the symbolic return value, rather than a syntactic literal-zero test.
Both validation and execution must receive the loader account count, and
execution must receive the custody output bump. Unknown solver results fail.

Trusted boundaries include the restricted interpreter, schema bridge, codec
and pure-root summaries, custody/effect helpers, loader, transaction rollback
and Clang/LLD/SBF. In particular, active successful CPI validation is assumed
to bound its meta count to eight. This is an explicit helper postcondition,
not an obligation proved by assuming itself, and no separate helper proof is
automatically composed. Helpers are assumed not to change managed-state bytes
or saved state/codec buffers; CPI may refresh local `accounts[i].size` metadata.
Some generated local names select symbolic field identities, so equivalent
renamings can reject. Mutation classifications refer to the restricted model;
they are not executions of every mutant in LiteSVM. No claim covers arbitrary
C, unlisted adapters, runtime aborts during commit, or ABI 3.


## ABI 3 select/plan helper slice (under final review)

`npm run verify:collection-runtime` symbolically executes the parsed bodies of
`bend_collection_select` and `bend_collection_plan` against independent range
and append contracts. It covers arbitrary u32 fields, including length greater
than capacity; no valid-collection precondition hides select's defensive guard.
Success fields and refusal nonmutation are checked with C conversions and lazy
boolean evaluation. The nested plan-to-select call uses the parsed select body.
Mutation receipts distinguish semantic counterexamples, undefined reads and
unsupported syntax. UNKNOWN and nonzero child results exercise the real parent
failure path. Source hashes are checked at publication; previous reports are
archived before replacement.

Pointers must designate valid, appropriately disjoint objects. The parser,
interpreter and Z3 bridge remain trusted. This slice does not prove collection
opening, record pointers, commit, generated callers or SBF behavior. Those are
separate active tasks; inclusion in `verify:all` does not make them proved.
The integrated corrections still require final independent review and the full
integrated suite replay. See `build/collection-runtime-refinement.json` for the
recorded source hashes and exact obligations of a completed run.

### Custody helper component in token composition

The multi-token composition controller now requires a `custody` evidence child.
`verification/token_custody.py` extracts the live token-program key and accepts
only the reviewed custody helper body, seed sources, and syscall declaration.
The child checks helper success and caller SETUP/BUMP bindings, with six semantic
failure controls and four parser rejection controls per fixture. Report checking
requires the exact fixture/control inventory and rejects altered binding evidence.

The full adapter composition now assigns custody result and bump directly from
the parsed helper model. Its explicit `custody-success-contract` property checks
that a successful caller satisfies token identity/executable, PDA success/key,
and bump conditions. A separate `custody-caller` child uses the actual parsed
caller with abstract root summaries to check four deliberately incorrect
connections per fixture: missing result, wrong bump, missing executable check,
and wrong token-program identity. These must admit counterexamples.

Serialized-input checks have since entered maintained qualification, as described
below. PDA derivation and syscall output behavior remain trusted contracts. Physical allocation and helper/commit memory composition remain
separate obligations. The direct caller integration passed fresh focused
qualification, including 35 report refusals, five process controls, 11 input
controls, the wrapper launch-failure check, and successful restoration afterward.
The recorded source/artifact audit is in
`build/token-loader-scout/direct-custody-qualified/audit.json`; it qualifies its
recorded inputs, not future revisions.

### Serialized token inputs and precommit projection

The qualification controller now requires a private loader prerequisite and a
`serialized` child. It reruns the actual root/codec/helper composition, connects
initial account views to serialized bytes, and composes freshly proved guarded
helper-preservation obligations to check managed bytes before commit. Initial
formula reuse requires exact AST equality within the same run. Both instruction
modes need satisfiable full-model witnesses for each fixture; UNKNOWN refuses.

PDA witness substitutions must match a consistent total interpretation of the
trusted functions. The report validator checks exact query paths/hashes and
replays all six saved witness queries. Permanent `snapshot-controls` and
`pda-controls` children exercise omitted/shifted byte mappings and invalid witness
interpretations. The loader frontend accepts a private output directory so this
prerequisite does not share mutable receipts with other loader runs.

Fresh focused qualification passed for the recorded source snapshot, including
42 malformed-report refusals, five process controls, 11 input controls, the
missing-Python wrapper check, and a complete successful restoration run. The
maintained test invoked its report auditor before publishing success. Preserved
evidence is in `build/token-loader-scout/serialized-qualified/`; its terminal
receipt identifies `run-a4f2aa8c-57d0-4c83-a78a-c4d5900102b0`. This evidence does
not automatically qualify later source changes.

Physical commit projection is now integrated into maintained qualification for
the three fixtures. Bounded shared and per-handler phases connect concrete decoder
spans, simultaneous helper-snapshot representation, successful write paths,
root-sequence selection, and the selected helper memory to finite physical-store
induction. The shared phase proves 272 reusable lemmas; consumers check exact
ordered parsed SMT assertions against the bound producer queries. Strict phase
inventories and source/artifact hashes are checked before acceptance.

The initial full qualification and 60 report refusals, five process controls,
11 input controls, and wrapper launch-failure check passed. Its automatic
restoration failed closed on a token-four full-root solver UNKNOWN (timeout).
A fresh public qualification then passed with unchanged sources and limits.
The maintained auditor accepted that restoration against the completed controls;
a separate recovery audit checked the wrapper and retained the timeout evidence.
Evidence: `build/token-loader-scout/physical-recovered-qualified/`, with restored
run `run-00aaa44c-6f85-4d6c-ae37-e838d0d1855e`. This establishes the recovered
qualification workflow, not a successful exit of the original focused-test
command. The timeout remains a proof-performance limitation. Broader aggregate
qualification for this source snapshot is still pending.

The physical representation uses arbitrary helper post-state bytes outside
account data. Its patch theorem is not evidence that token helpers preserve
lamports or every metadata byte. Allocation provenance, runtime write frames,
PDA behavior, the reviewed C parser, finite-induction driver, and Z3 remain
explicit trust assumptions. No end-to-end compiler, SBF, SPL accounting, or
transaction rollback theorem follows from these results.

### Physical proof-cache controls

Run the standalone cache test from the repository root with the configured
Python environment containing Z3 5.1.0:

```sh
python3 -B tests/physical-proof-cache.py
```

It proves and reuses two small UNSAT lemmas and checks 17 refusal cases:
qualification/source mismatches, missing or reordered queries, changed formulas,
incomplete producers/consumers, SAT and injected UNKNOWN results, query or
manifest drift, and malformed success/result fields. UNKNOWN injection checks
failure handling deterministically; it is not a solver completeness claim.
Successful reports are written to unique directories under
`build/physical-proof-cache/`, bound to the cache module and test source hashes.
Assertions-disabled execution is refused.

This is a standalone machinery test, separate from the full composition gate.
The cache producer, exact parsed-query comparison, Python driver and Z3 remain
trusted; passing these controls does not independently certify cached proofs.

## Connected CPI caller qualification

The `verification/cpi_caller/` package connects three generated ABI 2 fixtures
(two, three and four managed state accounts) through checked source/C root
correspondence, actual canonical decoding and encoding, typed effect extraction,
and the parsed CPI validator. Caller account keys and owner identities use full
256-bit values. Account counts are checked at their full width before narrowing
for the validator. Concrete initialization/update inputs demonstrate that each
fixture's complete success path is reachable; these inputs do not constrain the
universal queries.

The caller checks ordered returns, context construction before instruction
processing, all encodes/validation/execution before managed commits, no adapter
writes on explicit failure, exact per-account headers/bindings/payload/reply,
and the source of each encoded field. Constructive output-assignment checks
prevent the connection equations from silently excluding otherwise valid base
inputs. Reused branch exclusions must come from fresh UNSAT queries whose exact
premises are included in the current proof context; UNKNOWN results refuse.

`verification/check-cpi-caller.ts` builds fresh fixtures and profiles, runs the
proof and report auditor, and publishes a receipt with exact source/artifact/log
hashes. `tests/cpi-caller.ts` adds callback, binding, extraction, root-mutation,
native, report-corruption and process-failure checks, then requires a fresh
successful restoration. Run `npm run verify:cpi-caller` for qualification or
`npm run test:cpi-caller` for the complete focused workflow. The qualification
command is the 55th registered aggregate check.

The complete focused workflow passed initial qualification, all controls and
fresh successful restoration. Evidence is `build/cpi-caller/focused.json`; its
source/artifact/child-report audit is `build/cpi-caller/focused-audit.json`.
Coverage includes 105 report refusals, four process failures, 24 extraction
mutations, six root counterexamples and their native replays, and 24 native
entrypoint scenarios. A new 55-command aggregate run remains required. These
results apply to the recorded source snapshot, not arbitrary future edits.

### Custody connection extension

The custody extension assigns the caller's setup result and PDA bump from a
reviewed model of the actual `bend_invoke_custody` helper. Its gate audits the
complete helper body, declaration and dependency bindings, seed prefix and
account-key sources. Full-width PDA status, derived key and bump are represented
by deterministic trusted syscall functions. Successful complete callers must
satisfy the resulting custody contract. This is a reviewed-template model;
it does not interpret arbitrary C or prove PDA cryptography.

An optional obligation callback groups the original guarded read, pointer and
bounds obligations by label. Existing adapter checks retain their original
combined-query default. CPI checks first try a stronger query using fresh proved
branch exclusions, then fall back to the complete binding query when needed.
UNKNOWN never establishes a claim. Reports require every expected group and
its proof method, along with the three custody-success claims.

The full three-fixture prototype and its source/artifact audit passed at
`build/cpi-custody-scout/full-reduced-audit.json`. The maintained focused workflow
adds custody template controls, fifteen actual-caller binding counterexamples,
five native helper scenarios and two native faulty-source controls. It requires
129 report-corruption refusals. **Fresh maintained qualification and restoration
for this extension are still pending**; the earlier focused receipt above does
not qualify these changes.

Separate staged descriptor-refresh and caller-frame components exercise
resizing between calls and check actual commit ranges under explicit runtime
write-frame assumptions. They are not included in this custody qualification
and do not establish a combined physical-memory theorem.

### Remaining assumptions

This connection does not prove the loader's physical representation, native
allocation validity, PDA cryptography, external CPI account effects, lamport
conservation, runtime rollback, Clang preservation, or SBF execution. Clock
results and external execution remain abstract; custody uses the reviewed model
and trusted PDA syscall described above. The
restricted C semantics, codecs, proof driver and solver remain trusted.

Native controls execute actual generated entrypoints with explicit PDA, clock,
CPI and return-data test doubles. They include an invalid second effect that must
be rejected before any helper call or state mutation, and a wrong-slot validation
mutation that demonstrates the test's sensitivity. Separate root counterexamples
compare pinned Bend evaluation with baseline and deliberately changed native C.
Sanitizer success and these test doubles are separate evidence from symbolic
proofs and transaction-runtime behavior.
