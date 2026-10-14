# Arithmetic and application refinement checks

## Full vault decision function in emitted C (experimental)

`npm run verify:vault-c` checks the full `process` function from
`examples/vault/vault.bend`, currently a 22-function runtime closure. It compares
actual default production C against the checked-source model for every valid
typed context, state and instruction. The current query is UNSAT, including 92
modeled C safety conditions. The existing C interpreter needs no new grammar
or application-specific lowering for this function.

A separate specification in `verification/vault_c.py` states fourteen properties
of the interpreted C result without using the source evaluator to define the
expected decisions:

- Accepted results have exactly the permitted authorization/instruction/balance
  conditions; unsigned or wrong-owner calls cannot succeed.
- Accepted state is live with the correct owner and mint; initialization starts
  at zero; successful deposits and withdrawals have exact, nonwrapping balances.
- There is one effect: initialization checks the specified mint, and deposit or
  withdrawal plans have the required account roles, mint, recipient, authority
  and amount.
- No modeled C safety violation is reachable on the typed domain.

All fourteen negated properties must be UNSAT. Initialization, positive deposits
and positive withdrawals must have SAT reachability witnesses. Three C mutations
must produce counterexamples: bypassed authorization, a wrong transfer role and
incorrect addition. The authorization witness is unsigned; the deposit witnesses
have nonzero amounts. `npm run test:vault-c` replays all three against Bend and
native C and confirms that the authorization mutant actually returns Accepted.
It also exercises 28 altered-report refusals, eight process/setup controls,
13 invalid-input refusals and forced solver UNKNOWN rejection.

The fresh parent binds the source, C, schema, run id, exact claim inventories,
Clang syntax acceptance and typed witnesses; retires previous success before
setup; checks process completion and source stability; and publishes
`build/vault-c-refinement.json`. Test evidence is `build/vault-c-test.json`.
These are conditional guarantees about a pure decision and its plan values.
Account decoding and validation, the executor, actual token/lamport conservation,
transaction rollback, Clang/LLVM and SBF behavior remain outside these proofs.
The source exporter, schema bridge, restricted C interpreter, driver and Z3 are
trusted. Host review has not been replaced by an independent review.

## Acyclic whole-function translation checks (experimental)

`npm run verify:acyclic-lowering` freshly exports checked Bend models and actual
production C for five roots in `tests/lowering.bend`, six in
`tests/generics.bend`, three in `examples/vault/vault.bend` and five in
`examples/vesting/vesting.bend`. The application roots cover authorization,
deposit/withdrawal result handling, initialization, payout/transfer planning and
funded-total projection. This command does not cover either complete application handler; the separate
`verify:vault-c` command above covers the pure vault decision function. A restricted Python interpreter evaluates the emitted C
independently of the checked-source evaluator. Nineteen negated equivalence
queries must be UNSAT for all valid typed inputs; seven incorrect C mutations
must produce SAT counterexamples. This compares function results and modeled
safety conditions, beyond the textual renderer checks below.

The accepted C subset has by-value unsigned 32-bit arithmetic, algebraic data
constructors, projections, acyclic calls, branches, scoped locals and returns.
Constructor summaries require the actual emitted maker and declaration checks.
The checker tracks overshifts, invalid variant projections, noncanonical Boolean
results, reachable `__builtin_unreachable` and missing returns. It rejects
unmodeled top-level declarations, unsupported signed arithmetic, pointers,
recursion and loops. Scope, const-local and function/type-name shadowing restrictions are checked. Typed inputs
exclude malformed tags and noncanonical Boolean encodings; byte decoding and
account authorization are outside this check.

The gate requires host Clang (`CC` selects it) to accept each actual C unit
with `-std=c11 -fsyntax-only`, records its version and artifact hashes, and
then runs the restricted symbolic interpreter. Frontend acceptance is an
additional check of C validity, not a proof of Clang or SBF correctness.
The gate uses Z3 5.1.0 and publishes
`build/acyclic-lowering/fresh-receipt.json`. It checks exact fixture, root,
mutation and result inventories; binds input, C and source hashes; checks child
completion; and retires previous success before run-directory setup. It
rechecks source membership and hashes after compilation and proof. This guards
against accidental source drift, not a filesystem attacker swapping and
restoring files between observations. The source exporter, primitive semantics,
restricted C parser/interpreter, proof driver, Z3 and ordinary C value/layout
semantics remain trusted. There is no theorem about LLVM, Clang, emitted SBF,
memory safety, transaction rollback, arbitrary compiler inputs or application
business laws. The command checks these nineteen fixture roots; it is not an
automatic certificate for every program build.

`npm run test:acyclic-lowering` exercises 22 report refusals, nine process/setup
controls, 14 invalid-input refusals, 19 grammar/boundary refusals and four modeled
safety counterexamples. Three equivalent scope variants and 30 expression
variants (360 native sanitizer cases) cross-check the interpreter. The seven
semantic mutation witnesses replay against the pinned Bend evaluator and native
Clang. These finite tests support the checker implementation; they are not a
proof of its soundness. The test receipt is `build/acyclic-lowering-test.json`.
The application mutations bypass authorization, alter a transfer account role,
and replace a beneficiary with the mint key. This establishes preservation of
the source helper decisions under the model, not independent correctness of the
application rules or the adapter that executes the resulting effects.
Host review and independent review are distinct; independent review of this
addition remains outstanding while delegation is suspended.

## Constructor/match routing checks (experimental)

The production backend now lowers non-scalar constructor applications and
matches through `compiler/tagged-sum-ir.ts`. Before rendering each operation it
checks the constructor identity/tag, field and argument types, projection order,
match scrutinee, and hit/miss argument routing against the runtime schema and
source operation supplied by the backend. Original trailing argument objects
are retained, including bounded-iteration descent metadata. Bool and Nat keep
their existing scalar lowering paths.

`npm run test:tagged-sum-ir` exercises checked Bend source, malformed IR and
mutations of the actual production IR generator in private compiler copies.
Its report is `build/tagged-sum-ir/report.json`; `npm test` includes this gate.
The existing lowering differential suite separately compares Bend evaluation,
native C and SBF, including compiled semantic mutations.

`npm run verify:tagged-sum-routing` now exports fresh production operations and
checks their routing with an independent Python/Z3 model. For each exported
shape, arguments and fields range over arbitrary opaque values, and scrutinee
tags range over the declared variants. The model checks constructor tags and
argument order, branch selection, field projections and hit/miss argument order.
The current lowering, generics and queue fixtures yield 100 instances and 71
distinct shapes (34 constructor, 37 match); all 71 negated equivalence queries
are UNSAT. Four deliberately incorrect routing mutations require SAT witnesses.
This establishes conditional equivalence for these exported shapes, not coverage
of every program accepted by the compiler.

The command requires Z3 5.1.0 and writes
`build/tagged-sum-routing-refinement.json`. Its parent captures source hashes
before loading the compiler, checks them after export and proof, and validates
the exact operation/proof inventory, run identity, checker and input hashes.
Previous success is moved aside before work; a new report is published only
after successful child completion and validation. The retained input artifact
contains the actual operations. `npm run test:tagged-sum-routing-receipt`
exercises malformed/stale/incomplete reports, failed children, timeout, forced
UNKNOWN, source drift and malformed inputs. The gate is included in
`npm run verify:all`; ordinary builds do not automatically run it.

The same gate now retains each fixture's actual emitted C and schema in its
hash-bound input artifact. A separate restricted Python interpreter checks the
49 constructor-maker bodies: return type, parameter types/order, returned tag,
selected union member and field assignments. For arbitrary by-value arguments,
the negated tag/field correspondence queries are UNSAT. Three altered emitted-C
bodies (wrong tag, wrong union member, swapped fields) require SAT witnesses;
extra statements, octal tag literals and missing field assignments must reject.
These grammar refusals are counted separately from solver proofs. The parser
also rejects preprocessing beyond the emitted pragma and unsupported lexical
forms, including additional comments, instead of searching through them for
success-looking definitions.

The gate also compares all 28 emitted tagged-sum struct/union declarations
against the schema, including tag type, member order, field types and required
size assertions. This is declaration correspondence, not a proof of Clang
layout or memory safety.

The checked-term source/schema bridge, standard C value/layout semantics,
independent interpreters and proof driver, Z3, process environment and filesystem are
trusted. Hash checks detect observed changes but do not defend against
adversarial change-and-restore races.

The gate additionally checks the production renderer's 100 recorded operations:
constructor-call argument text, match conditions, field projections, and hit/miss
argument expressions must match the proven IR routing. Constructor calls and
tagged-match branch blocks must match their recorded multisets within the function that emitted each record. Unknown function owners,
missing or duplicated calls, and relocation of intact blocks across functions
reject. These are textual translation checks (`MATCH`),
not additional solver proofs. The inputs remain opaque C expressions, and the
source-to-operation and continuation associations are trusted. Call counts do
not establish evaluation order or how returned values are used. The check does
not prove that each branch body implements its source continuation or interpret
the whole C translation unit. LLVM and SBF remain outside its proof boundary.

`npm run test:tagged-sum-rendering` mutates the actual production renderer in a
private compiler copy. It requires successful emission and independent rejection
for incorrect constructor argument order, match tag, projection index, hit
expression order and fallback expressions. Restoring the renderer must restore
the baseline artifact exactly. Twelve additional emitted-C fault cases include
unused correct calls hiding wrong returns, digraph macros, cross-function block
moves, and declaration mismatches. Four native comparisons establish changed
results for representative semantic faults before the corrected checker rejects
them. Metadata capture does not alter generated C;
the three current fixtures and seven application/reference baselines were
compared byte for byte before and after it. The latter retain both their
historical full-emission hashes and updated metadata-inclusive hashes.

This is a production validation boundary, **not a formal preservation theorem**.
The checked-term-to-schema/source bridge, C expression generation, renderer,
C compiler and target execution remain trusted or separately tested; constructor
makers now have the conditional check described above. The evidence is returned
in memory by `Backend.emit`; no independently
checkable per-build lowering certificate is emitted yet. Independent review of
the new host work remains outstanding. A 32-command refinement and full
regression pass preceded the latest function-ownership, declaration and
report-publication corrections; those corrections require their own replay.


## Conditional ABI 3 caller paths

`npm run verify:collection-caller` regenerates the two-U32 collection fixture
from current checked source and analyzes its actual C caller and entrypoint.
The restricted path model checks refusal ordering, initialization, selection,
record access, plan-before-commit and subsequent writes. Entry proves the
account-count, instruction-mode and argument conditions used by the inner
caller. The focused gate has 206 obligation instances, 38 rejected mutations
and seven equivalent rewrites; grammar restrictions are not counted as proofs.

The generated type/root/codec headers and runtime headers must match fixed
reviewed SHA-256 byte hashes independently of the candidate manifest. Changed
headers fail closed until reviewed. The pin restricts accepted artifacts; it
is not a proof of header semantics. Helper purity (including absence of CPI,
logging or return-data effects), codecs, loader behavior and accepted-plan
commit semantics remain explicit assumptions. Helper proofs are not yet
consumed by this gate. This checks one fixture, not general ABI 3, C memory
safety, LLVM/SBF preservation or an end-to-end verified compiler.

`npm run test:collection-caller-receipt` runs a fresh successful parent and
four failure injections in a minimal private source copy: forged output,
nonzero child exit after success, source drift and archive conflict. It checks
actual error lines, nonzero exits, report freshness and preservation of prior
bytes. Python runs with `-I -B`; a second TypeScript check validates the probe
report and diagnostics. This focused test needs the documented Python/Z3 setup
and is separate from ordinary `npm test`. Shared dependency symlinks are
writable; the trusted drivers only read them. Concurrent source edits fail the
hash comparison, so run it against a stable source tree.

Fresh reports bind invocation inputs and before/after source hashes. Failure
retires the canonical report and preserves prior evidence. Independent review
replayed header-extension attacks and receipt failures. Full integrated suites
must be rerun after later source changes.

Run every supported refinement command with `npm run verify:all`. It fails on
any failed command and indexes snapshots of the 30 reports in
`build/refinement-suite.json`. Each entry's `artifact` points to a content-addressed
copy under `build/refinement-reports/`; `sourceArtifact` names the command's
usual output. Later focused runs can replace that output without invalidating
the suite's captured report bytes. Snapshots preserve reports, not their entire
source/input dependency trees: a report still applies only to its recorded
inputs. Old indexes and reports first move to same-directory
`<report-path>.<uuid>.quarantine` files, then are archived. If archiving fails,
the quarantine preserves the original bytes and the conventional path remains
absent. Newly failed child output is also kept in quarantine for diagnosis,
including when the child wrote `passed:true` before exiting unsuccessfully.
A failed or incomplete suite leaves no new success index. Earlier successful
children and untouched later children can still have conventional reports;
only a completed suite index establishes a successful combined run. The archive
can contain previously canonical reports and indexes of differing status;
presence in that directory alone is not acceptance evidence.
`npm run test:refinement-suite` checks overwrites, partial runs, stale/missing or
malformed reports, explicit failure, signals, timeouts, publication followed by
failure, and corrupt snapshots. Timeout cleanup covers the direct child;
detached descendants and hostile filesystem mutation are outside this contract.
The production suite does not currently set a timeout.
These checks remain separate from `npm test` and from production program builds. See the [three-application audit](acceptance-audit.md)
and [AMM audit](amm-acceptance-audit.md) for historical integrated milestone
evidence. The [container milestone review](containers-acceptance-audit.md) records
the accepted generic-container and bounded-iteration expansion.

## Compiler assurance categories

The evidence in this repository has different scopes. A proof about application
rules is not automatically a proof about lowering or execution of those rules.

| Layer | Formal or symbolic checks | Execution evidence and remaining boundary |
| --- | --- | --- |
| Bend source | Declared Bend laws and selected SMT source refinements | Checker, exporter and specifications remain trusted |
| Selected arithmetic lowering | Source algorithm proofs and audited C-template/bitvector bridges | Reference/native/SBF differentials; no whole-backend preservation theorem |
| Bend-to-C lowering | Conditional equivalence of selected complete typed function closures, with separate Nat-ranked loop checks; no theorem for every accepted program | Differential, sanitizer and mutation tests; exporters, interpreters and compositional proof drivers remain trusted |
| ABI 1 emitted adapter | Restricted interpretation of actual written C against the account/effect/commit contract | Native and SBF tests; call summaries and interpreter remain trusted |
| Codecs and extraction | Selected codec properties, schema-linked layout and field-mapping checks | Native malformed-input and sanitizer tests; not general C verification |
| Token/CPI helpers | Actual validator bodies checked for return behavior and guarded reads | Custody/executor native tests and SBF integration; syscalls and rollback remain assumptions |
| ABI 2 emitted adapter | Restricted symbolic execution of nine pure/token/CPI fixtures with two through four state accounts | Helper summaries remain assumptions; existing account-binding and rollback tests are separate evidence |
| ABI 3 adapter | Restricted helper/caller checks and a connected serialized-entry, root/codec and byte-write model for one pure collection fixture | Allocation validity, C-object separation and external effects remain assumptions; native authorization, lifecycle, frame and rollback tests provide separate evidence |
| C-to-SBF and runtime | Restricted checks of selected actual SBF arithmetic and handler fragments; no whole-program preservation theorem | Pinned toolchain, reproducibility and LiteSVM tests; LLVM, loader/VM behavior and external execution remain outside the whole-program claim |

The custom parsers, symbolic interpreters, dependency audits and solver drivers
are part of the trusted machinery. Their negative tests, independent reviews
and compiled witness replays are evidence about that machinery, not proofs of
its correctness. A connected, mechanically verified lowering slice would reduce
that boundary; a theorem about a disconnected model would not establish that
the production backend implements it.

## Emitted adapter control flow

`npm run verify:adapter-contract` checks twelve written ABI 1 adapter artifacts
against an independent symbolic contract. It covers validation, root inputs,
effect ordering, explicit error returns, and exact commit/return bytes, with
adversarial checker tests and mutated emitted-C artifacts. The restricted C
interpreter and helper summaries remain trusted. A separate restricted,
schema-linked check now covers emitted extraction field mapping, initialization
and confinement under well-formed native-value preconditions; its checker and
schema-to-C bridge are trusted. `npm run test:effect-extraction` adds independent
native ASan/UBSan differential evidence. Codecs, root lowering, effect
validation/execution, runtime aborts and compilation retain explicit assumptions.
This is not a build-time certificate for arbitrary adapters or an end-to-end
SBF proof.
See [adapter assurance](adapter-assurance.md#symbolic-check-of-emitted-abi-1-adapters)
for the precise boundary and pinned failure precedence.

`npm run verify:multi-adapter-contract` extends this approach to nine written
ABI 2 entrypoints. Its independent schema/interface contract checks failure
precedence, root arguments, effect ordering, exact per-account commits and
complete replies. The accepted run has 54 UNSAT claims, 348 stage witnesses,
69 rejected mutations and five accepted equivalent variants. This remains
restricted interpretation of recorded C, with trusted codecs/root/helper
summaries, loader and toolchain; it is not a composed helper proof or a
certificate for arbitrary program builds. See the
[ABI 2 scope and checker regressions](adapter-assurance.md#symbolic-check-of-emitted-abi-2-adapters).

## Arbitrary CPI validation

`npm run verify:cpi-validator` symbolically executes the actual
`bend_invoke_validate` body in `runtime/bend_cpi.h` with a restricted parser and
bounded interpreter. For valid native objects and account counts 4–12, it checks
exact success/error behavior against a separate capability contract, guarded
read bounds and loop termination, and complete, exclusive return coverage.
Mutated C artifacts must reject or produce solver counterexamples; equivalent
rewrites must pass. The report is `build/cpi-validator-refinement.json`.
The checker, dependency bridge and key-equality summary remain trusted. This
command does not prove custody setup, execution, syscalls, the adapter's writable
state exclusion, application authorization or compiled SBF behavior. See
[the helper contract](adapter-assurance.md#arbitrary-cpi-helper-contract).

`npm run verify:cpi-composition` adds 32 conditional facts from the parsed live
validator, an exact-token audit of the complete executor body, and a separate
mathematical loop-index bound. It assumes caller account counts 4–12 and valid
native objects. It records four reachability/inactive witnesses, five semantic
validator mutations, eight executor grammar rejections, and two equivalent
variants in `build/cpi-composition-refinement.json`. Executor boundary examples
are illustrations from the original validator relation, not executions of
mutated C. The allowed post-CPI update to local account-size metadata is explicit.

The helper-only `verify:cpi-composition` command does not establish emitted-adapter composition.
The caller must bind the same effect, account array/count and custody bump,
preserve relevant effect fields, and validate before execution. The gate does
not inspect compiler templates or prove that an emitted loop implements its
mathematical obligation. Syscalls, aliases, rollback and C-to-SBF preservation
remain outside its scope. Exact input/header hashes are recorded and checked
for changes during the run; failed/unknown child checks cannot publish success.

## Token validation

`npm run verify:token-validator` parses the live `bend_transfer_validate` body
and checks account/data read bounds, exact error/success behavior and exclusive
return coverage against a separately written contract. Native flags, indices,
amounts, lengths and bytes are symbolic; account counts are restricted to 4–12.
`read_le` and `equal_key` have audited bodies and summarized semantics. The
include closure rejects function overloads, alternate attribute spellings and
duplicate summarized-helper bindings. Restricted C parsing and interpretation,
the policy contract, declaration bridge and solver remain trusted.

The standalone report is `build/token-validator-refinement.json`. This is not
proof composition with extraction or the adapter and does not establish custody
identity, executor correctness, token-program behavior or C-to-SBF preservation.
The contract's error precedence intentionally mirrors the helper; agreement does
not independently establish that every application needs exactly this policy.
See [token helper assurance](adapter-assurance.md#token-helper-contract) for
caller obligations and separate native evidence.

## Containers, iteration and batch settlement

The suite now includes `verify:buffer`, `verify:iteration`, `verify:fold` and
`verify:batch`. Buffer checks prove access, update and append behavior for the
supplied two/four-slot adapters. Iteration and fold checks cover all admitted
fuel values, 0–64, with arbitrary payloads. The batch check composes checked u64
arithmetic with ordered traversal and compares full funding/settlement outcomes,
including state and exact token effects. It passes 788 obligations and requires
seven faulty source variants to yield both symbolic counterexamples and concrete
Bend mismatches.

See [containers.md](containers.md), [iteration.md](iteration.md) and
[batch-refinement.md](batch-refinement.md) for contracts and proof boundaries.
Generic specialization also has 11 source-model claims and two mutations in
`test:generics`, included in `npm test`; it is not a separate sixteenth command.

## Checked u64 arithmetic


`npm run verify:arithmetic` checks universal u64 properties in addition to the
ordinary Bend laws and differential tests. It requires Python 3 with the Z3
Python binding reporting version **5.1.0**; `PYTHON` selects another interpreter.
The command fails if the solver is missing, mismatched, returns unknown/times out,
or finds a counterexample. The project does not install global Python packages.

For every pair of unsigned 64-bit inputs, the current check establishes:

- `Math.add` returns the exact mathematical sum if it fits, otherwise error 1.
  A 65-bit sum distinguishes overflow from modular conservation.
- `Math.sub` returns the exact nonnegative difference, otherwise error 2.
- `Math.less` and `Math.equal` agree with unsigned 64-bit ordering/equality.
- No modeled impossible-match branch is reachable from valid typed inputs.

These are universal finite-domain SMT results, not an enumeration of test
vectors. They are conditional on the primitive semantics and trust boundary below.

## Connection to the implementation

`verification/model.ts` loads and checks the real Bend source, runs the ordinary
backend's subset/type/provenance validation, and exports runtime terms from
checked `Def.e` definitions. It uses the compiler's reachable function set and
type schema, without substituting handwritten limb arithmetic.

`verification/prove.py` symbolically evaluates variables, lambdas, fully applied
calls, constructors, bindings and matches. Records/unions use Z3 algebraic
datatypes, U32 uses 32-bit bitvectors and Bool uses Boolean values. Unsupported
terms or primitives are errors.

The primitive model specifies wrapping U32 add/subtract/multiply, unsigned U32
division (zero divisor returns zero), comparisons, bitwise AND/OR, one-bit left
shift, Boolean operations and Bool-to-U32 conversion. The checker/backend
require these names to come from pinned Base. The verifier assumes these
semantics; it does not prove Base's implemented `Word` operations refine them.

For each root the solver searches for a result that disagrees with the mathematical
specification or a reachable impossible-match branch. Only `unsat` passes.
Each obligation has a 30-second limit; `unknown` is failure, not evidence.

## Negative checks and artifacts

Three mutated implementations reverse carry, remove borrow and reverse high-limb
comparison. Each must yield a SAT counterexample, not a timeout. Those inputs
are replayed through Bend's reference evaluator on the mutated checked source
and must disagree with an independent BigInt specification. Original sources
are unchanged. This connects reported counterexamples back to source behavior.

`build/math-refinement.model.json` contains the exported checked model.
`build/math-refinement.json` records the solver/version, model hash, per-root
results, mutation counterexamples and Bend/BigInt replays, pinned Bend commit,
and hashes of the arithmetic source, verifier and primitive table.

The initial run returned UNSAT for all four positive obligations. All three
mutations produced counterexamples that replayed in Bend evaluation.

## Assurance boundary

This check trusts the Bend checker, exporter, symbolic evaluator, primitive
specifications, Z3 and surrounding report code. It is a separate solver-backed
verification path, not a proof term checked by Bend. It does not prove the
generated C, LLVM transformations, SBF binary, adapter or external effects correct.
Differential/sanitizer/SBF tests provide separate evidence for those paths.

`npm run test:lowering` adds a focused check of representative compiler lowering:
U32/Bool operations, records and variants, calls and locals, pattern matches,
and bounded Nat iteration. It compares 454 deterministic checked Bend reference
cases with sanitizer-enabled native C and the emitted SBF program in LiteSVM,
requires eight malformed wire inputs to reject in both target paths, and
requires five independently compiled emitter mutations to produce semantic
mismatches on named vectors: field selection, primitive expression, constructor
branch, argument order and bounded iteration.
`npm test` includes the same cases in its ordinary SBF regression run. The
mutations check deliberately faulty C emissions, while the source refinements
above do not verify C lowering or the SBF binary. This remains test evidence for
the exercised cases, not a compiler preservation proof. The
[ABI 1 adapter assurance plan](adapter-assurance.md) separately defines the
account/commit contract and traces it to generated C; its template-order audit
is regression evidence, not a semantic preservation proof.
The `verify:account-key` check ties a universal 32-byte equality
bitvector claim to the exact reviewed runtime C helper, subject to its stated
C memory and compilation assumptions.
The `verify:codec-primitives` bridge audits exact generated U32,
Bool and bounded Nat codec C templates and proves their bitvector properties.
Its scope stops before ADT encoding, C compilation and SBF execution.
Both are included in `verify:all` and retain separate hashed reports.
The `verify:codec-structures` command adds restricted generated-C conformance
and compositional layout checks for 11 recorded schema instances, including
nested ADTs, padding and boundary sizes. Its solver checks use parsed summaries;
they do not interpret C or verify the parser. It is the twenty-first suite
command. Separate native and SBF wire matrices exercise compiled behavior.
See [canonical codec assurance](codec-assurance.md) for exact scope, assumptions,
mutation checks and evidence. The ABI 1 semantic adapter harness separately
executes generated C against an independent contract oracle with mocked effect
helpers; see [adapter assurance](adapter-assurance.md).

Application transition invariants, multiplication and wide division/rounding
are covered by the separate commands below. Ordinary `npm test` retains its
existing prerequisites; the solver command must be run explicitly for refinement
claims. A program build does not imply that this command was run on its source.

## Historical compiler-preservation plan

The list below records the earlier plan. Later sections in this document cover
implemented tagged-sum routing, ABI 2 token composition, and ABI 3 collection
entry/memory checks; this list is not the current completion inventory. Those
results retain their stated scope and assumptions. No project-level Lean gate
or end-to-end compiler verification is established.

The original implementation targets were:

1. **ABI 2 integration and helper composition.** The nine-fixture emitted-C
   contract gate is implemented. Finish independent native adapter coverage,
   bind helper proof inputs to the adapter's exact include closure, and discharge
   the helper summaries before claiming composition. Preserve the actual ABI 2
   CPI precedence: helper errors precede writable-managed-state rejection,
   unlike ABI 1. Existing template and SBF tests remain separate evidence.
2. **ABI 3 collection semantics.** Add the selection root, five-argument
   transition and separate `bend_collection_run` helper. State binding,
   capacity/length/stride, window bounds and origin, append planning, record
   writes and alias exclusion need explicit claims. The collection runtime's
   open/select/plan/commit helpers need their own contracts; extending the
   entrypoint model must not silently treat those helpers as proved.
3. **A mechanically checked lowering slice.** Constructor and pattern-match
   lowering in `Backend.expr`/`Backend.body` is a candidate: prove that a
   well-formed constructor chooses the same branch and binds the same ordered
   fields in an explicit tagged-sum intermediate representation. Connect the
   production backend to that representation and check its emitted instances;
   a theorem about a separate toy translator would leave production lowering
   unconnected. The initial boundary would still include the source-AST bridge,
   C printer/layout, LLVM and SBF. Pin the proof toolchain and reject proof holes
   and added axioms. The pinned Bend checkout contains a Lean formalization,
   but its stated differences from `bend.ts` prevent assuming their semantics
   coincide. No project-level Lean proof gate is currently established.

## Complete u64 division check

```sh
npm run verify:division
```

This command uses the same checked-term exporter and solver prerequisites. For
every 64-bit quotient register `q`, remainder `r` and divisor `d`, with `d > 0`
and `r < d`, it proves the actual checked `Math.div_step` implements:

```text
n = 2*r + most_significant_bit(q)       // exact 65-bit intermediate
take = n >= d
next_remainder = take ? n-d : n
next_quotient = (2*q modulo 2^64) + (take ? 1 : 0)
next_divisor = d
0 <= next_remainder < d
```

It also rejects any reachable impossible-match branch under those preconditions.
The extra carry bit matters when the step is reused by wide division with a
nonzero initial high-limb remainder. Dropping it can produce an incorrect result
even though the low 64 bits of the shifted remainder look smaller than `d`.

A structural check on the **exported checked terms** verifies that `div2` calls
`div_step` twice, each subsequent composition doubles its predecessor, and
`div32` and `div64` consequently contain 32 and 64 steps. This checks the
composition tree;
it does not infer correctness merely from function names or comments.

Negative checks discard the remainder carry and discard the quotient shift.
Both must yield SAT counterexamples, which are replayed in Bend evaluation
against independent BigInt step semantics. A third mutation drops half the
`div64` steps and must fail the structural composition check. Reports and source/
verifier hashes are in `build/division-refinement.json`; the checked model is in
`build/division-refinement.model.json`.

The command now continues from the step and composition checks into 68 induction
obligations in `verification/division_loop.py`:

- For each of the 64 iterations, establish how the register packs the unconsumed
  dividend suffix above the processed quotient bits, how shifting consumes the
  next bit, and that both pieces fit their allotted widths.
- Preserve the exact integer invariant `N = (D*V + R)*S + U`, where `V` is the
  processed quotient, `R` the remainder, `U` the unconsumed suffix and
  `S = 2^(64-i)` after iteration `i`.
- Preserve `0 <= R < D` and show that the doubled remainder/incoming bit fits
  the 65-bit intermediate used in the step proof.
- Establish initialization with zero quotient prefix and a valid high-limb
  remainder, then show that after 64 steps the suffix is zero and
  `N = D*quotient + remainder`, with `0 <= remainder < D`.

The checked composition tree links those induction obligations to the actual
source steps. Another 33 obligations prove that the first 32 dividend-prefix
steps cannot subtract when the high dividend limb is below the divisor. The
`(low limb shifted into quotient, high limb as remainder)` state correctly
starts the remaining 32 steps. Only after these checks pass may the wrapper
evaluator use the established division result as a summary for `div32` and
`div64`. It verifies the checked public `divmod`, `div` and `mod` definitions:
zero divisor returns error 3; a smaller dividend or divisor one returns its
direct exact result; a high dividend limb below the divisor takes the guarded
32-step path; all other nonzero cases take the 64-step path. It checks source guards, initial
states, returned fields and path coverage. The final integer identity and
remainder bound characterize the unsigned Euclidean quotient/remainder.

Five wrapper source mutations swap the returned quotient/remainder, change the
zero-divisor error, corrupt the smaller-dividend exit, corrupt the
high-divisor initial quotient state, and admit equality in the 32-step guard.
The equality mutation replays `a=274877907007, b=64`: its 32-step result is
`q=4294967295, r=127` versus exact `q=4294967296, r=63`. The mutations leave
the step/induction intact but
fail wrapper checks; their solver inputs are replayed in Bend against BigInt
division/remainder.

All step, induction, fast-path and wrapper obligations return UNSAT. Seven
semantic mutations produce replayed counterexamples and the missing-step
mutation is rejected.
The older `verify:division-step` command remains an alias for the complete check.

This is a compositional verification argument: the solver obligations, induction
driver, connection to the checked composition and wrapper summaries remain part
of the trusted verifier. It is not a Bend-checked proof term or verification of
C/LLVM/SBF lowering. The complete wide multiply/divide API remains outside these division claims, even though the loop induction also permits a
valid nonzero initial high-limb remainder.

## Native arithmetic lowering bridge

`npm run verify:native-arithmetic` requires current passing division and
multiplication refinement reports. It checks the exact generated C bodies for
the pinned `Math.divmod` and `Math.mul32` definitions and runs Z3 bitvector
obligations for packing the two U32 limbs, zero-divisor behavior, unsigned
quotient/remainder and the exact 32-by-32 product. A wrong-operator mutation
must produce a counterexample. `tests/native-arithmetic.ts` checks that a
changed SDK definition falls back to ordinary Bend lowering. The compiler
requires the exact checked SDK module source digest and function signatures
before using these native operations. The proof/model exporter explicitly
disables this lowering, so source refinements continue to inspect the checked
Bend definitions.

This connects proved source arithmetic to a reviewed C template under C
unsigned-integer semantics. It trusts source extraction, the digest gate,
template audit, C compilation and LLVM/SBF execution. Arithmetic differential
tests and matched SBF benchmarks separately exercise compiled code; neither
the bridge nor those tests constitute a general compiler-correctness proof.


## Compositional multiplication check

```sh
npm run verify:multiplication
```

This command checks `Math.mul32` (exact 32 × 32 → 64), `Math.mul`
(checked 64 × 64 → 64, error 1 on overflow), and `Wide.product`
(exact 64 × 64 → 128). It also establishes wrapping `Wide.add`.
It uses the same Python/Z3 prerequisite and checked-term exporter.

Fourteen obligations connect the actual checked source to integer multiplication:

1. Symbolically execute `mul32_parts`, `mul_parts`, `Wide.add` and
   `Wide.product_parts` on arbitrary partial products. Check carries, shifts,
   overflow rejection and absence of reachable impossible branches. Check the
   wide module's imported `math.mul32_parts` independently as well.
2. Establish integer polynomial expansion for 16-bit and 32-bit limbs, bounds
   on their partial/full products, and the checked-u64 overflow criterion.
3. Verify the checked `mul32` bodies select the correct 16-bit operands and
   feed their four products into the established assembly. Primitive operands
   are proved to fit 16 bits, so their product fits U32 without truncation.
4. Verify the checked `mul` and `Wide.product` bodies select the correct 32-bit
   pairs, feed them into the proved assemblies, and use the correct high-product
   overflow flag. Both the standalone and imported `mul32` are checked first.

The routing checks use uninterpreted partial-product functions, while the
integer lemmas establish their multiplication interpretation. Assembly summaries
are enabled only after the underlying checked definitions pass. This avoids
bit-blasting two large multiplier circuits against one another. The composition
of these lemmas and summaries is part of the trusted Python proof driver; it is
not a Bend proof term or an end-to-end compiler theorem.

Four source mutations remove a middle carry, ignore high-product overflow,
remove a wide-add carry and misplace a cross product. Their helper-level SAT
counterexamples replay through Bend and disagree with independent BigInt
specifications. Three further mutations select incorrect limbs in `mul32`,
`mul` and `Wide.product`. Each produces a SAT routing result and a separately
chosen concrete Bend witness. Abstract routing counterexamples are **not**
claimed to be realizable integer multiplication inputs.

`build/multiplication-refinement.{math,wide}.model.json` contains the checked
models. `build/multiplication-refinement.json` records all obligations, seven
mutations, replays/witnesses, model/source/verifier hashes and the pinned Bend
commit. Only UNSAT passes positive obligations; timeouts/unknown fail.

The current command passes all fourteen obligations and all seven negative
checks. Wide division, the composed multiply/divide API and floor/ceiling
rounding are not yet covered by this command.


## Wide division and rounding

```sh
npm run verify:wide
```

This command checks the complete shared wide-arithmetic API: `Wide.divide`,
`Wide.mul_div`, `Wide.floor` and `Wide.ceil`. It uses the same pinned solver,
checked-term exporter and trust boundary as the preceding commands.

Before using summaries, it reruns all fourteen multiplication obligations and
fresh canonical division proofs: restoring-step semantics, 68 induction
obligations, 33 fast-path lemmas and three division wrappers. Exact helper-closure
and type comparisons bind the wide module's imported `math.divmod` and
`math.div64` to those canonical definitions. Nine integer lemmas establish
Euclidean uniqueness, the high-zero width/result connection, numerator equality
and divisor-one fit. Fifteen additional small-divisor claims connect integer
bounds, unsigned limb interpretation, and the actual checked helper arguments
and results. Twelve API obligations check the wrapper, six exhaustive
dispatch domains, overflow/rounding facts and composed operations. Case checks
make error and route behavior explicit without strengthening the universal
wrapper theorem.

- For `N = high*2^64 + low` and a positive u64 divisor `d`, the quotient overflows
  u64 exactly when `high >= d`.
- Euclidean quotient/remainder characterize floor and ceiling:
  `floor(N/d) = q`, `ceil(N/d) = q + (r != 0)`.
- The checked `divide` wrapper returns error 3 for zero divisor, error 1 for
  quotient overflow, and `(low, 0)` for a fitting divisor of one. It calls
  `Math.divmod(low, d)` when the high word is zero. Fitting nonzero-high
  inputs with a 32-bit divisor use two checked u64 divisions; the proved bounds
  justify quotient-limb extraction and remainder reuse. For larger divisors,
  the 64-step fallback retains `(low, high, d)`. Separate obligations
  check exact callee arguments, guards, error precedence and route results.
- The checked `mul_div` composes the exact product with wide division, using the
  correct arguments and divisor.
- The checked `floor` forwards errors and returns the quotient.
- The checked `ceil` forwards errors, increments only for nonzero remainder,
  and returns error 1 if that increment exceeds u64. The actual checked addition
  is symbolically evaluated here, including its carry and overflow behavior.

Wrapper checks deliberately quantify arbitrary loop quotient/remainder or
abstract product results after proving their prerequisites. They check routing,
guards and result handling without rebuilding a monolithic multiplication/
division circuit. The soundness of this composition remains a trusted part of
the verifier, not a proof term checked by Bend.

Fifteen source mutations include a discarded high dividend, reversed overflow
guard, changed zero-divisor error, wrong native-route guards or operands, lost
zero-error precedence, swapped multiplier/divisor inputs, returned remainder
instead of floor, reversed exact-rounding guard, discarded ceiling increment,
and three incorrect limb assemblies in the small-divisor helpers.
Each must produce SAT for its targeted obligation while the product/loop
prerequisites still pass. Each also has an independent concrete Bend/BigInt
witness; these are not presented as replays of abstract SMT inputs.
Unknown/timeouts are rejected for all positive and negative obligations.

`build/wide-refinement.{math.model.json,model.json,json}` contains the checked
models and the report, including all prerequisite results, 33 fast-path lemmas,
nine width-bridge lemmas, eleven API obligations, twelve mutation witnesses
and source/verifier hashes. These claims cover the shared arithmetic, not the
vesting/exchange economic invariants or compiled C/LLVM/SBF behavior.

`npm run test:wide-refinement` runs fresh proofs and four isolated process
controls: disabled Python assertions, missing Python, empty child output and
source drift after real proof execution. The driver archives prior success
before prerequisites, checks captured input hashes before publication and
publishes the completed report by rename. Failed attempts do not leave an old
success at the canonical report path.


## Vesting funding and payout accounting

```sh
npm run verify:vesting
```

This check symbolically executes the actual checked `initialize_instruction`
and `claim_result` definitions, including their arithmetic and effect builders.
It uses no arithmetic or application summaries. Four obligations establish:

- For an `Ok{vested}` input, `claim_result` rejects above-total entitlement with
  error 4, regressed entitlement with error 5 and zero payout with error 6.
  Otherwise it updates only `claimed` to `vested` and emits exactly one transfer
  of `vested - old_claimed` from custody to the beneficiary, with the scheduled
  mint and prescribed account indices. Every other schedule field is preserved.
- On that accepted path, a 65-bit equation establishes exact integer accounting:
  `old_claimed + payout = new_claimed <= total`. This is not merely a wrapping
  u64 equality. Together with initialization at zero it supplies the inductive
  payout-accounting invariant for successive accepted claims.
- Any arithmetic error supplied to `claim_result` produces rejection 4.
- Initialization requires a signature, nonzero total and `start < end`. Its
  accepted outcome initializes claimed to zero and requests exactly the total
  funding amount from actor to custody, preserving beneficiary, mint and times.

Four well-typed mutations reset claimed to zero, reverse the funding cap, change
payout authority to actor and request zero initialization funding. Each must yield
SAT for its target obligation. The scalar counterexample is replayed in Bend
with fixed distinct beneficiary/mint keys, and the complete outcome must differ
from an independently constructed expected outcome. Timeouts are failures.

Models, results, replays and provenance are in `build/vesting-refinement.*`.
These results establish the pure outcome/effect description. They do not prove
that a transfer actually occurs: account validation, CPI execution and atomic
commit remain adapter/runtime assumptions tested separately. The funding/payout command alone does not
connect the time-dependent `entitlement` calculation or the complete authorized
`process` entrypoint to this invariant; the additional command below supplies
those connections. A supplied entitlement below the funded cap could still be
incorrect for the current slot.


## Complete vesting source transition

```sh
npm run verify:vesting-process
```

This command exports the actual `process` runtime closure. Before using any
arithmetic summary, it compares every checked definition reachable from the
imported `Wide.floor` against the wide-arithmetic proof's exported model. The
comparison normalizes import qualification and omits generated C names; bodies,
signatures, primitive flags and semantic type schemas must agree. A corrupted
imported definition is rejected by a dedicated binding test. The command then
reruns the wide-arithmetic proof and vesting funding/payout prerequisites.

Six additional obligations connect these results:

- For `start < end`, entitlement is zero at/before start, total at/after end,
  and otherwise `floor(total * (now-start) / (end-start))`. The checked source
  calls floor exactly on the interior path with those exact arguments. Subtraction
  does not underflow and duration is positive on that path.
- Integer bounds show the intermediate product fits u128 and the resulting
  quotient lies between zero and total, hence wide floor cannot return overflow
  or division-by-zero for a valid schedule.
- All four state/instruction cases of the actual `process` definition match the
  specification: Empty/Initialize validates signature/schedule and funds exactly
  total; Empty/Claim rejects with 2; Live/Initialize rejects with 7; Live/Claim
  requires a runtime signature and exact beneficiary key, then returns the
  checked entitlement/payout result. Context/key equality is symbolically
  evaluated from its checked implementation.

On schedules created by successful initialization, accepted claims therefore
update claimed to the time-based entitlement and transfer exactly its increase.
The prior 65-bit conservation equation gives cumulative requested payouts at
most the funded total. Repeated claims with unchanged entitlement reject, a
regressed entitlement cannot subtract below zero, and claims at/after the end
request only the remaining funded amount. Schedule fields remain unchanged.

These are compositional source-level SMT claims. Summaries quantify arbitrary
intermediate results only after their implementations and import identities
have passed. The proof driver remains trusted. The account adapter must supply
truthful signer/key/slot context, enforce valid storage, execute the described
transfer and commit state atomically. Existing SBF tests cover that integration;
this command does not prove the adapter or deployed machine code.

Four well-typed source mutations remove the signature requirement, invert the
beneficiary check, invert the start guard and reverse duration subtraction.
Each fails its targeted obligation while the prerequisites pass, and each has an
independent concrete full-entrypoint Bend/BigInt witness. Abstract SMT inputs
are not claimed to be concrete arithmetic counterexamples. Reports, checked
models, mutation witnesses and source/verifier hashes are in
`build/vesting-process.*`.

## Complete vault source transition

```sh
npm run verify:vault
```

This command symbolically executes the full checked `process` closure without
arithmetic or application summaries. It checks all six state/instruction cases
for arbitrary keys, signature flags, slots, u64 balances and amounts:

- Empty/Initialize requires a signature, sets owner to the actor and balance to
  zero, preserves the supplied mint and emits exactly the expected mint check.
- Empty/Deposit and Empty/Withdraw reject with error 2.
- Every Live operation requires a signature and actor equal to stored owner.
  A repeated Initialize rejects with error 3 after authorization.
- Deposit rejects overflow with error 4. Otherwise the balance increases by
  exactly the amount transferred from actor to custody, with unchanged owner
  and mint and the prescribed transfer indices/recipient/authority.
- Withdraw rejects insufficient balance with error 5. Otherwise the balance
  decreases by exactly the amount transferred from custody to the owner actor,
  again preserving owner and mint and checking the complete effect structure.

Two additional 65-bit equations establish integer conservation on accepted
paths: `new_balance = old_balance + deposit` and
`old_balance = new_balance + withdrawal`. Together with zero initialization,
these establish cumulative source-level accounting without modular overflow.
Zero-amount operations follow the source semantics and are not rejected here.

Five well-typed source mutations remove the signature requirement, invert owner
authorization, emit a zero deposit transfer, add instead of subtract on withdrawal,
and initialize a nonzero balance. Each must produce SAT for its target obligation.
The complete solver input, including all key words, is replayed through Bend and
its complete outcome must disagree with independently constructed BigInt effects
and state. Unknown/timeouts are failures.

The checked model and report are in `build/vault-refinement.*`, with mutation
replays, hashes and pinned versions. This establishes the source transition and
its declared effects. It assumes truthful runtime context, correct account
validation and atomic execution of token effects. It does not prove the adapter,
Token Program, compiler or deployed machine code, or prevent unsolicited token
transfers from making custody assets exceed the vault's accounted balance.

## Complete fixed-price exchange source transition

```sh
npm run verify:exchange
```

This command binds the complete imported `Wide.ceil` dependency closure to the
checked arithmetic model, rechecks its proofs, and then evaluates the actual
exchange `process` closure with only ceiling arithmetic summarized. All nine
state/instruction cases are checked for arbitrary keys, flags, u64 quantities,
price components, maximum payment and arithmetic results:

- Empty/Initialize requires a signature, different base/quote mints, and positive
  quantity/numerator/denominator. Acceptance records the actor as maker, preserves
  the parameters, funds exactly the offered base quantity and checks the quote mint.
- Empty/Fill and Empty/Cancel reject; every instruction on Closed rejects.
  Open/Initialize rejects without replacing the offer.
- Open/Fill requires a signature, positive quantity no greater than remaining
  inventory, a successful price calculation, positive payment and payment no
  greater than the taker's maximum. The checked call to ceiling uses exactly
  `(quantity, numerator, denominator)` on the valid-quantity path.
- Acceptance decreases remaining by exactly the filled quantity and preserves
  maker, mint and price fields. It describes exactly two ordered transfers:
  quote payment from actor to maker, then base quantity from custody to actor,
  with the specified account indices, mint keys, recipients and authorities.
  Exhausting inventory transitions to Closed.
- Open/Cancel requires the maker's signature, describes a custody refund of
  exactly the remaining base quantity to that actor, and transitions to Closed.

Two additional integer obligations establish non-wrapping inventory conservation
and ceiling pricing. For positive quantity, numerator and denominator, payment
is positive and satisfies `(payment-1)*denominator < quantity*numerator <=
payment*denominator`. The arithmetic prerequisite establishes the exact ceiling
or an overflow error; the entrypoint rejects errors and enforces the maximum.
Rounding and maximum-payment guarantees are **per fill**, not an aggregate price
promise across multiple fills.

Six source mutations remove fill signing, invert cancellation ownership,
reverse slippage, increase inventory on fill, transfer zero quote tokens and
invert the price ratio. Each must fail its target obligation while prerequisites
pass. Each has an independent concrete full-entrypoint Bend/BigInt witness;
abstract pricing counterexamples are not labeled concrete solver replays.
A separate corrupted-model test requires rejection of changed imported ceiling
code. Models, reports, witnesses and provenance are in
`build/exchange-refinement.*`.

The trusted driver composes the ceiling theorem with the entrypoint proof. This
is a source-level SMT argument, not a Bend proof term or deployed-binary proof.
Both token legs and state updates must execute atomically in the adapter/runtime;
that integration remains covered by the existing SBF rollback and lifecycle tests.

## Integer square root

`npm run verify:sqrt` exports the checked `sdk/sqrt.bend` closure and verifies
71 obligations: the trial-bit step, initialization/extraction and geometric-mean
wrappers, three initial intervals, 64 interval-preservation steps, and the final
floor characterization. A structural audit requires the actual `step2` through
`step64` definitions to double their predecessor exactly. The multiplication
summary is permitted only after matching the imported checked function/type
closure to the separately exported wide implementation and passing its 14
multiplication obligations.

For each bit `b`, the integer invariant is `r² <= target < (r+2b)²`, with
`0 <= r` and `r+2b <= 2^64`. A candidate `r+b` therefore fits u64. The checked
step selects that candidate exactly when its full-width square is at most the
target, and shifts `b` right once. The resulting interval is
`r'² <= target < (r'+b)²`. At the final bit `b=1`, this is precisely floor square
root. The source wrapper runs 16 steps from `r=0,b=2^15` for targets below
`2^32`, 32 steps from `r=0,b=2^31` for the remaining targets below `2^64`,
and 64 steps from `r=0,b=2^63` otherwise. The checked wrapper proves disjoint, exhaustive routing and exact
initial arguments. The smaller initial intervals use `target < 2^32` and `target < 2^64`,
with the same preserved invariant for the final 16 or 32 steps.

The bitvector product is abstracted only after its implementation is proved.
Connecting that product interpretation and the checked composition tree to the
integer induction is part of the trusted proof driver, as with division.
This is a source theorem, not a proof of emitted C, LLVM or SBF behavior.

Nine well-typed semantic mutations produce SAT results and concrete Bend
counterexamples: reversed comparison, discarded accepted bit, non-advancing bit,
wrong candidate, missing initial top bit, wrong small-path initial bit, and
a width guard that checks the low word instead of the high word, a wrong
narrow-path initial bit, and a narrow guard that checks the low limb. A skipped half-loop fails the
composition audit; a corrupted imported product fails source binding. UNKNOWN
is failure, not success. The report and source hashes are in
`build/sqrt-refinement.json`. The full refinement suite includes this command.

## AMM quote arithmetic

`npm run verify:amm-pricing` proves 11 obligations. Four route the checked
`fee`, `swap`, `deposit`, and `withdraw` definitions through source-bound wide
arithmetic. Both imported floor and ceiling closures must match the standalone
checked SDK model; its product, division, and rounding proofs run before any
summary is used. Seven integer lemmas establish fee bounds, the swap output and
reserve-product bounds, positive ceiling payments, withdrawal floor bounds,
and deposit/withdrawal rounding that does not dilute existing liquidity.

For swaps, with positive reserves `x,y` and effective input `e`, a floor quote
`q` satisfies `q*(x+e) <= y*e < (q+1)*(x+e)`. The proof establishes `0 <= q < y`.
Crediting gross input `g >= e` then gives `(x+g)*(y-q) >= x*y`. The checked quote
also rejects gross reserve overflow, zero effective input, and zero output.
The rounded fee `ceil(g*30/10000)` is between zero and `g`, and fits u64, over
all u64 inputs. The wide arithmetic theorem supplies the actual floor/ceiling
semantics and overflow behavior; arbitrary abstract results in the routing
proof are not an assumption that errors disappear.

For deposits, ceiling payment `d` obeys `d*L >= r*s`, hence
`(r+d)*L >= r*(L+s)`. For withdrawals, floor receipt `d` obeys `d*L <= r*s`,
hence `(r-d)*L >= r*(L-s)`. These are quote-level reserve-per-share properties.
Connecting them to the pool's actual state updates, authorization, locked
liquidity and exact token effects requires the separate transition proof,
described below.

Six semantic mutations yield SAT and independent concrete Bend witnesses:
wrong fee, wrong output reserve, missing gross capacity check, incorrect
deposit/withdrawal ratios, and accepting zero output. Corrupting either imported
floor or ceiling definition fails source binding. Reports, source hashes and
witnesses are in `build/amm-pricing-refinement.json`. UNKNOWN fails the command.


## Complete AMM source transition

`npm run verify:amm` checks 32 obligations against the exported checked
`amm.process` source. The proof enumerates both state constructors and all
instruction constructors (including both swap directions), and compares the
entire outcome: error priority, immutable configuration, reserve/share updates,
and all three token effects with their indices, mint keys, recipient,
authority, reserve bindings and initialization flags. Initialization is split
into exhaustive guard partitions. A strict schema audit rejects additional
uncovered constructors or fields.

The source key-equality helper is proved equivalent to full 256-bit equality.
The three imported quote closures and geometric-mean closure must exactly match
the independently exported, proved models. Pricing and square-root prerequisites
run again before their summaries are admitted. Checked add/sub helpers are
proved before using word-level contracts. The square-root step similarly uses
three proved helpers (wrapping addition, halving and 128-bit comparison), checks
both multiplication arguments, and verifies routing for an arbitrary product
result. This decomposition avoids solver timeouts without accepting UNKNOWN or
assuming a helper is correct. An intentionally broken halving helper is rejected.

Integer accounting obligations cover reserve credits/debits, positive reachable
reserves, locked accounting shares, circulating LP backing (including external
burns), and solvency relative to recorded reserves. These compose with the
quote-level rounding and product lemmas above. Runtime validation and SPL Token
execution/atomicity remain assumptions, tested separately on SBF; the theorem
does not verify the compiler or token program.

The global accounting invariant is `actual_base >= recorded_base > 0`,
`actual_quote >= recorded_quote > 0`, `total_shares >= 1,000`, and
`outstanding_LP_supply <= total_shares - 1,000`. Initialization establishes it
from fresh empty reserves and matching funding effects. Deposits, withdrawals,
and both swap directions preserve the reserve inequalities when their exact
source-bound token effects succeed; unsolicited donations add surplus without
changing recorded reserves, and external LP burns only reduce outstanding
supply. The claim-bound obligation additionally proves that if aggregate
integer LP payouts `C` satisfy the per-holder floor bound
`total_shares * C <= recorded_reserve * outstanding_LP_supply`, then `C` is
strictly less than that reserve. The floor quote inequality gives the premise
for each holder, and summing those inequalities covers any finite partition of
the outstanding supply.

This is a backing/no-overdraw invariant for **current pro-rata claims**, not a
promise that each account can immediately redeem positive units of both tokens:
the source rejects withdrawals whose rounded payout is zero on either side.
Nor is the reserve-balance invariant an end-to-end theorem about arbitrary SPL
mint authorities or compiled SBF; those execution assumptions remain covered by
separate runtime tests.

Ten source mutations produce SAT plus independently evaluated Bend witnesses:
unsigned execution, wrong LP mint, withdrawal crediting a reserve, removed locked
liquidity, omitted swap input credit, wrong payout recipient, zero LP issuance,
an unbound reserve address, underfunded recorded reserves, and LP issuance not
reflected in accounting shares. Four imported-source corruptions and an extra
instruction constructor are rejected. `build/amm-refinement.json` records the
obligations, witnesses, prerequisite reports, and source hashes.


### Conditional emitted CPI adapter composition

`npm run verify:cpi-adapter` regenerates ABI2 cpi-2/3/4 fixtures and connects
parsed helper facts to parsed adapter calls. It checks effect identity,
account array/count, validation status and custody bump, execution ordering,
and each active meta scan's own effect count. The gate inventories world axioms
before/after parsing and checks active/inactive count-9 witnesses for every slot
with legacy assumptions disabled. A fresh source snapshot is bound into the run;
no historical build directory is required.

It records nine emitted-C semantic counterexamples, one grammar refusal,
four equivalents, and six actual parsed-observation faults. Each fault is
rejected, and disabling its specific solver query admits it. These sensitivity
checks are not emitted-C mutations or whole-gate executions. Separate account-array
C mutation, changed-axiom and helper-link removal checks retain distinct evidence.
Ten solver-query entries per fixture are bookkeeping, not another theorem.

The report is `build/cpi-adapter-composition-refinement.json`; `verify:all` now
contains 30 checks. Bun, Python/the driver, Z3, the restricted C interpreter and
its solver remain trusted. The inventory does not independently certify all
solver assertions after parsing. One redundant helper-instantiation query lacks
a distinct sensitivity test. Nonces/hashes reject stale replay and drift, not
a forging trusted driver. The result covers recorded fixtures conditionally;
it proves no custody PDA correctness, arbitrary CPI behavior, external-account
postconditions, rollback, LLVM/SBF preservation or deployment.


`npm run test:cpi-adapter-receipt` performs a fresh successful real-parent run
in a minimal private source copy with no historical baseline manifest. It then
adds two hidden count assumptions and removes two groups of solver checks in
separate copies. Each actual parent must reject with its exact diagnostic,
clear the canonical report and preserve the previous successful receipt bytes.
Main source hashes must remain unchanged throughout. This optional regression
requires the same Bun/Bend/Python/Z3 prerequisites as the CPI gate and is separate
from `npm test`; it is not an independent proof-driver implementation. Shared
dependency symlinks are trusted reads, not OS-enforced read-only mounts.


### Collection open, record and commit lifecycle bridge

`npm run verify:collection-lifecycle` interprets the supported C definitions in
`runtime/bend_collection_runtime.h` and checks their open/record/commit contracts.
It is included in `verify:all`. The accepted checker reports 23 runtime
obligations, two cached correspondence lemmas with 18 applications, two generic
arithmetic regression lemmas, and 18 grammar restrictions. These categories
must not be summed into a count of independent runtime proofs.

Independent review reproduced the former leading-zero literal false pass in
native C and confirmed that both signed and unsigned variants now reject at
the literal grammar. The reviewed run rejects 49 mutations and accepts 13
supported equivalent forms. `npm run test:collection-lifecycle-receipt` checks
publication, source drift, malformed results, injected UNKNOWN, failed children
and native counterexamples separately. Main replay results are recorded under
`build/overnight/collection-lifecycle-*.log`; a running log is not a pass receipt.

The span/bitvector composition remains a prose argument. Caller facts from
open/select/plan, object representation, signed right shift and narrowing remain
assumptions. Parent validation now pins the exact grammar restriction inventory
and assumption text as well as runtime claim inventories. Invalid mixed-case
long-long suffixes (`uLl` and `ulL`) reject, matching C17; valid forms such as
`uLL` and `Ull` remain accepted. Forged receipts with missing, replaced or extra
restrictions or assumptions, and generic rejection reasons for the signed and
unsigned octal controls, reject for their intended reasons. Independent review
and both focused main-tree gates passed; the additional evidence is recorded in
`build/overnight/collection-low-main-*-terminal.json`. These corrections close
the four follow-up findings without strengthening the theorem scope. None
establishes a C-to-SBF theorem.


### Collection helper-to-caller composition bridge

`npm run verify:collection-composition` performs one fresh parent run of the
collection runtime helper, lifecycle helper, and generated-caller check. It
binds their receipts to a single run id, captures their exact receipt-byte
hashes, and reparses the emitted ABI-3 capacity-two U32 C plus its headers,
schema, interface, manifest, and include closure. The caller's open, select,
record, plan, and commit calls instantiate the same versioned typed formulas
that the helper body checkers consume. The report keeps solver obligations,
source grammar restrictions, emitted-C mutants, and parsed-observation
sensitivity faults in separate inventories.

The result proves this fixture's modeled argument, status, output, bounded
window, record pointer, scratch extent, guarded-encoder, refusal, and successful
write-path links under the listed assumptions. The commit query includes the
full typed precondition, including the allocation-size/capacity relation; it
does not drop that clause based on an imported claim name. Initialization and stored-mode
complete paths, loaded counts zero through two, written counts zero through
two, and open refusal paths must have solver witnesses. A mutation that removes
one imported contract link or parsed control-flow dependency must admit a SAT
counterexample to its corresponding caller claim; a successful check records
the witness polarity explicitly. Scratch bounds are tested against the caller
guard rather than the redundant plan contract. The post-commit return-data
fault changes only the observed consequence, retaining the real commit
antecedent even when their path formulas are structurally identical.
`npm run test:collection-composition-receipt` reruns the complete positive
parent, then checks missing, duplicate, extra, stale, narrowed, and altered
receipt cases plus injected child-failure, timeout, and UNKNOWN rejection.

The world assumptions remain explicit: valid and disjoint stable loader objects,
target C integer and pointer representations, syscall behavior, and pure
schema-correct codecs and roots. The lifecycle span/bitvector result remains a
prose-level source-width argument, not one combined SMT pointer-range theorem.
The bridge does not claim C-to-SBF preservation, transaction rollback, or an
end-to-end verified compiler. It does not reinterpret object identity as an SMT
claim. Each report binds only the exact source and generated bytes recorded in
that invocation; prior reports are archived as evidence and never consumed as a
new proof.


## Vault shared-artifact bridge

`npm run verify:vault-adapter` checks the actual `examples/vault/PROOF.bend`
root `vault.process`, the native header included by its generated ABI 1 adapter,
and the matching schema and canonical codecs in one fresh artifact set. It runs
the full-root equivalence check, 14 independent decision/plan invariants, 104
codec layout obligations with freshly checked primitive base cases, and the
ABI 1 adapter contract. Additional call-site checks require successful state
and instruction decoding and a canonical Boolean signer before invoking the
root (434 adapter obligations in this fixture). Clang syntax-checks the written
adapter; this does not prove compilation preserves semantics.

The gate writes `build/vault-adapter-bridge/fresh-receipt.json` only after every
child completes and recorded source/artifact hashes remain unchanged. UUID run
directories preserve intermediate artifacts and reports; prior receipts are
retired before setup, including Python launch failure. Exact named inventories
reject duplicate/substituted codec claims and call records. Run
`npm run test:vault-adapter` for report, input and process-failure controls.

This is conditional co-validation of shared artifacts, not an end-to-end SBF
theorem. The source exporter/schema association, restricted C interpreters and
parsers, proof drivers and Z3 remain trusted. Bounds/nonoverlap use the modeled
separation of local C objects and loader regions. Actual memory provenance,
loader correctness, helper noninterference, CPI execution/rollback and
Clang/LLD/SBF preservation remain assumptions. An additional connected model substitutes symbolic byte-decoder semantics and
actual emitted root C into adapter control flow. It proves unsigned and wrong-
owner inputs cannot succeed, commit state, encode a result, or invoke post-
decision effects under the stated helper assumptions. It checks root C safety
without the added result bindings. Root-call guards are disjoint, and explicit
output choices prove the bindings preserve every input allowed by the base
model. Missing, contradictory, overlapping and circular bindings reject.

The codec model consumes validated emitted offsets, tags and padding. Across
this artifact's 13 types it checks 26 universal round trips and 13 reachable
accepted-byte domains. Failed codec outputs are unspecified and discarded;
only success predicates and successful values/bytes carry guarantees. Focused
tests compare 312 cases against actual native codecs under UBSan, exercise
256 temporary decoder inputs, and replay a fault witness from raw account and
instruction bytes through native decoding and the root. An authorization-
bypass C mutation is detected by the connected model, with native rejection
by the original and acceptance by the mutant on an unsigned request.

The connected model now also binds the state encoder's success flag and 76
output bytes to the actual root's returned state. Across the two root-call
paths, 79 symbolic outputs are assigned by four guarded rows. The binding
audit checks the exact allowed outputs and equations, disjoint guards for
shared outputs, absence of output dependencies in guards/values, and that
every base input admits consistent assignments. Five malformed-binding
controls include misclassifying an input as an output.

Eight claims concern committed bytes: decoding recovers the actual returned
state; the payload is canonical; initialization has zero balance and binds
owner/mint; deposits obey a nonwrapping 65-bit equation; withdrawals cannot
underflow; successful state is Live; updates preserve owner/mint. Successful
initialization and nonzero deposits/withdrawals are reachable. An addition-to-
subtraction C fault violates the deposit equation, and native replay decodes
the recorded input and reproduces the exact erroneous committed payload.

These accounting claims concern the state account's recorded balance. Actual
token effects, helper execution/noninterference, loader memory and rollback
remain assumptions; this is not a conservation proof across token accounts
or an end-to-end SBF preservation theorem. Independent review is pending.


### Connected vault effect extraction

The vault-adapter gate also connects the actual C result's effects to the
parsed, audited fixed-record extraction bodies. Thirteen symbolic claims cover
typed single/plural path coverage, disjointness, successful extraction, and all
139 fields and bytes of each of two slots. The connected model checks helper
call order and active slots, initialization's mint check, transfer roles, amounts,
and all mint-key bytes. A wrong-destination mutation violates the deposit claim
and is replayed through native decoding, the actual root C, and extraction; the
baseline is compared with checked Bend. Native extraction comparisons cover 48
values under UBSan and detect deliberately swapped expected amount limbs.

The adapter calls the helper for both slots; slot 1 is inactive. A helper-call
event is not itself evidence of a token transfer. Validation/execution helper
results and their memory effects remain abstract, and actual token conservation,
rollback, loader behavior, and Clang/LLD/SBF preservation are not established.
The typed extraction module currently accepts fixed token-effect records and
explicitly rejects vector and CPI layouts. Source/schema correspondence, the
restricted parsers, symbolic models, proof driver, and Z3 remain trusted.


### Parsed token validation in the vault adapter bridge

The connected vault model binds both validation results to the parsed
`runtime/token.h` helper, using the actual extracted effect fields and shared
account key, privilege and size observations. Eight additional named claims
cover the full-width caller count, guarded reads, exact result and return
coverage, and transfer executor index/read/authority prerequisites. A separate
proof establishes that validation results do not depend on reserved accounts'
data or owners. Those observations remain independent token inputs.

The wrong-destination control retains a SAT witness for the incorrect root
plan; with the actual validator connected, successful deposit is unreachable
for that control. Baseline initialization, deposit and withdrawal each require
a SAT success witness. Do not describe the incorrect plan as a committed bad
transfer. Report inventories require both observations.

Focused tests include binding shape/type refusals, a high-bit account-count
check, native C comparisons under UBSan with nonuniform key bytes, and a
deliberately reversed key-binding control. Record fresh focused and aggregate
results separately; adding these checks does not establish they have passed.

Execution helpers, custody, loader and memory isolation remain modeled or
trusted. These checks do not establish SPL Token conservation, preservation of
all validation predicates across multiple effects, or an SBF theorem.


The acyclic C fixture inventory additionally includes vesting `delta`,
`difference`, `bounded`, `claim_result`, `initialize_instruction` and `empty`.
These compare actual default-production C against the checked-source model,
including checked subtraction, claimed-state updates and initialization
authorization. Three additional faulty-C witnesses have native replay checks.
The gate now requires 25 equivalence queries and ten semantic counterexamples.
Vesting entitlement division and the full vesting handler remain outside this
acyclic C coverage. Record fresh gate results separately from these requirements.


### Connected reviewed token executor

The vault adapter bridge now binds helper returns to a conditional summary of
the exact reviewed token executor body. The summary preserves the full 64-bit
syscall result for Transfer, MintTo and Burn, and returns zero for other opcodes.
The binding inventory is 86 outputs in 10 rows. Thirteen validator/executor
claims include caller key distinctness, CPI metas excluding managed state, and
the extraction authority convention. MintTo/Burn cases are inactive in this
vault fixture; their generic premise checks remain separate evidence.

The gate checks the complete helper body, ABI declarations and amount writer,
with altered-body/dependency refusals and exact report/module bindings. This
is reviewed-body conformance, not general C semantic preservation. Syscall
behavior, native object validity and disjointness, and runtime memory isolation
remain assumptions. In particular, it does not establish arbitrary later-effect
validation preservation, SPL Token conservation or an end-to-end SBF theorem.
Fresh validation results must be recorded separately from this implementation.


## Token data frame and pre-batch predicates

`npm run verify:token-frame` checks the parsed token validator under a stated
byte frame. Account keys, owners, sizes and flags remain fixed. Only accounts
4 through 11 may change; 82-byte mints may change bytes `[36,44)`, and 165-byte
token accounts may change `[64,108)` and `[121,129)`. These spans include supply,
balances and delegate bookkeeping. This is an overapproximation of data changes,
not a proof that an actual token program or runtime enforces the frame.

The gate checks the validator's three underlying safety/coverage contracts and
31 return guards and values. Returns are unchanged when the relevant
`initialize` and `fresh_destination` flags are disabled. With those flags
enabled, two SAT witnesses demonstrate that a previously successful validator
can return 24 after supply changes or 26 after a destination balance changes.
These guards describe pre-batch state, as specified by the effect interface.
The checks do not establish once-only initialization or post-CPI freshness.

Two further UNSAT claims preserve managed-state data and executor decimals
reads under the frame. Allowing state or decimals writes produces SAT controls.
Native object validity/disjointness, local effect records and actual syscall
frame enforcement remain trusted. `npm run test:token-frame` adds exact report
refusals, stale-success process controls and real C replay of both before/after
witnesses under ASan/UBSan. Wide report values use decimal strings. The gate is
in the 37-command refinement suite; finite native checks remain separate.


## Issuance probe composition

`npm run verify:issuance-adapter` connects the actual checked
`tests/token-issuance.bend` executor probe to its emitted C root, canonical
input/state codecs, three extracted Mint/BoundTransfer/Burn slots, parsed token
validation, reviewed executor result summary, and parsed adapter commit writes.
This is a caller-controlled test probe, not an application authorization policy.
The compiler contains no special lowering for this fixture.

The checker proves canonical committed state and the probe's modulo-U32 counter
increment, effect amounts and account indices matching the decoded instruction,
validation before execution, ordered helper calls, and commit after successful
helper returns. Thirteen validator/executor obligations are checked at each
modeled call site; the 936 split queries are instances of those obligations,
not 936 distinct protocol laws. Eighteen symbolic outputs in ten guarded rows
are audited for complete, acyclic bindings that do not restrict base inputs.
A concrete valid instruction must have a SAT success witness; an independently
wrong destination binding must not succeed.

Two emitted-C faults (wrong Mint amount and counter increment) must produce
named semantic counterexamples while retaining successful paths. The focused
`npm run test:issuance-adapter` replays these concrete inputs against the Bend
reference evaluator and original/mutated native C under ASan/UBSan. It also
checks report completeness, source/artifact hashes, failure publication, and
refusal of optimized Python that would disable assertions. Each gate uses a
fresh run directory and publishes `build/issuance-adapter/fresh-receipt.json`
only after the proof and exact report inventory checks succeed.

Validation sees one pre-execution account snapshot. CPI behavior, custody and
clock syscalls, native object separation, loader correctness, runtime rollback,
and Clang/SBF lowering remain modeled or trusted. The reviewed executor summary
is not a general C execution proof. These checks establish neither SPL Token
conservation nor preservation of every predicate after a preceding CPI, and
are not an end-to-end SBF theorem. The token-frame checks document the separate
conditions needed for data noninterference. Fresh gate and test results must
be recorded separately from these verification requirements.


### Successive token effects under a byte frame

The issuance bridge now instantiates three generic preservation lemmas at the
actual parsed Mint/Transfer/Burn execution positions. Each lemma starts from
pre-batch validation success and permits arbitrary changes throughout the
size-qualified token write spans documented above. All other account bytes and
metadata remain fixed. Seventeen call-site/frame checks cover durable validation,
executor index/read/authority premises, unchanged decimals, managed-account bytes,
reachable calls and two deliberately unframed-write counterexamples.

The zero-supply and fresh-destination flags describe pre-batch checks. The
post-effect theorem explicitly removes those two predicates when checking the
remaining validation conditions; it does not claim they stay true after execution.
Concrete input pins are used only for existential witnesses. Universal safety
queries retain the full input domain. The generic lemmas are proved before their
exact slot/account substitutions are supplied to the caller solver.

`test:token-frame` also checks exact symbolic coverage of the frame constructor.
This detects both an overly restrictive frame (omitted account or byte) and an
excessive frame (decimals writes), plus malformed argument refusals.

`test:issuance-adapter` now includes full generated host-C adapter execution with
framed syscall stubs: 16 scenarios cover initialization/update, counter wraparound,
wide amounts and failure at each effect. It checks unchanged managed-state bytes
at every call, expected later call data, commit after successful effects and return
bytes. Deliberate early commit and decimals corruption are detected. Eight further
native checks exercise initially enabled pre-batch predicates through three rounds
of permitted byte changes. These runs use ASan/UBSan. Stubs do not implement SPL
Token or runtime rollback; earlier token-data writes intentionally remain visible
in the host harness after an injected failure.

A separate instrumented host-C probe now observes the encoded state, extracted
effects, outcome, and account descriptors at every syscall boundary. Sixteen
sequence cases check those objects remain unchanged and disjoint from all
exposed account, instruction, metadata, and signer-seed pointer spans. Mutations
that expose the encoded buffer through an account pointer or modify an effect
inside the helper must fail for the corresponding observation. Its controller
also rejects disabled assertions, a missing compiler, and an empty compiler
result, archiving prior success before restoring a fresh positive run.
Instrumentation changes object layout: this supplements the uninstrumented
sequence tests and does not prove native/SBF object separation or runtime frame
enforcement. Evidence is `build/issuance-pending/fresh-receipt.json` and
`build/issuance-pending/process-controls.json`; the parent issuance test includes
both reports.

The isolated focused suite passed both fresh qualifications, original semantic
mutants, 40 report refusals, process controls and native replays. Its audited
receipt is `build/token-sequence-integration/audit.json`. The tested files have
been promoted. Fresh main issuance qualification, 40 report refusals, both
original semantic-fault native replays, 16 full-adapter scenarios and their two
fault controls passed. The main token-frame focused suite also passed, including
the new exact-coverage model checks. Main evidence is audited in
`build/token-sequence-integration/main-audit.json`. The preceding
44-entry aggregate result predates this addition. Runtime enforcement of the
frame, native object separation (including local pending buffers), loader behavior,
SPL accounting and SBF preservation remain assumptions or separate obligations.

## Modular acyclic source-to-C preservation

`npm run verify:modular-lowering` checks complete exported function closures for
`sdk/sqrt.bend` (`floor`, `geometric_mean`) and the aggregate, generic, vault and
vesting helper fixtures listed in `verification/modular-source.ts`. The current
inventory contains 37 square-root closure functions and 49 function instances
across the other four artifacts. These are selected artifacts and helper roots;
this does not establish preservation of complete vault or vesting handlers.
Each artifact must match default production C emission byte for byte.

The checker proves functions in source dependency order. A callee gets a shared
uninterpreted summary only after its own source/C equality and C safety query
passes for all valid typed arguments. Equality under arbitrary shared summaries
then lifts to callers by induction over the acyclic dependency graph. Unknown
callees, cycles, incomplete closures and solver UNKNOWN results reject. Actual
constructor bodies and aggregate declarations are checked separately. The
modular interpreter extends the shared acyclic interpreter with unsigned
division and an explicit division-by-zero guard; existing acyclic entrypoints
retain their original grammar.

Six mutations cover addition, division safety, iteration composition, width
selection, vault authorization and the vesting beneficiary. A SAT model with
abstract callee summaries need not be a concrete whole-program witness.
`npm run test:modular-lowering` separately executes original and mutated C with
AddressSanitizer/UndefinedBehaviorSanitizer: arithmetic is compared with Python's
integer square root, and application witnesses with pinned Bend evaluation.
The focused gate also rejects corrupted reports, dependency faults, stale
success after child-process failure, optimized Python and injected solver
UNKNOWN results. Fresh receipts bind source inventories, input bytes, reports
and logs; no success receipt is published after a failed stage.

This is conditional preservation for valid typed values in an acyclic,
side-effect-free subset. The exporter, schema correspondence, interpreters,
proof driver, solver and host tools remain trusted. Pointer/memory ABI behavior,
external effects, loops and recursion, C optimization and final SBF execution
are outside the theorem. Source arithmetic specifications and application laws
remain separate checks; this gate adds no production-readiness claim.


## Complete vesting, exchange and AMM C checks with native arithmetic

`npm run verify:native-handlers` checks the complete `vesting.process`,
`exchange.process` and `amm.process` closures from their respective
`examples/*/PROOF.bend` build
entrypoints against the actual default production C. These entrypoints also
pass the ordinary adjacent-law proof gate. The gate recomputes fourteen
multiplication obligations and the canonical division step, induction, fast-path
and wrapper obligations from freshly exported checked SDK models. Each handler
has two certified native leaves: 32-by-32 multiplication and u64 division with
remainder. Both require exact source helper-closure/type correspondence and
reviewed C signatures, result layouts, constructors and complete body templates.
This template correspondence remains a trusted bridge; it is not a general
interpreter for arbitrary 64-bit C.

The shared modular checker proves 61 ordinary function instances in vesting,
62 in exchange and 111 in AMM, plus two certified native leaves per handler. Source functions
omitted by native lowering must belong to the certified leaf's dependency
closure. Every remaining source/C function is checked in dependency order.
Actual aggregate declarations, constructors and the complete C translation-unit
inventory are checked as well. These are preservation checks for valid typed
arguments, separate from the application-specific protocol invariants.

`npm run test:native-handlers` exercises report and dependency refusals,
inconclusive solver rejection, missing process/frontend failures and failed
run-directory setup. It detects authorization and native-product mutations in
each handler. AMM adds semantic controls for slippage and reserve selection.
Thirty-six full-entrypoint cases match pinned Bend evaluation under ASan/UBSan,
and eight full-entrypoint fault replays differ as expected. Those
finite executions are separate evidence from the universal function queries.

Fresh success is retired before fallible setup. Unique runs bind checked source,
canonical arithmetic models, actual C, frontend results, prerequisite proofs,
function reports and logs. The exporter, schema correspondence, source/C
interpreters, template bridge, proof driver, Z3 and host tools remain trusted.
This does not prove account validation, CPI effects, rollback, Clang/LLVM
optimization or final SBF execution, and adds no production-readiness claim.


The earlier multiplication-only three-handler focused suite passed, including AMM's 20 reference
cases and four native fault replays. The matching native-body suite also passed
for all three fixtures. Evidence is audited in
`build/amm-handler-scout/main-audit.json`. These results extend the selected
artifact coverage without adding an application-specific compiler branch. The
preceding 44-entry aggregate receipt predates this fixture expansion.


## Parsed SBF-C native multiplication and division bodies

`npm run verify:native-body` starts a fresh native-handler gate for the three
PROOF entrypoints above, including checked-source export, fresh multiplication
and division prerequisites and complete handler closure checks. It then parses
both native leaves per handler (six bodies) with pinned Anza Clang 20.1.7 using
the SBF target and checks their typed ASTs with restricted unsigned-scalar
interpreters. Universal bitvector queries check the multiplication product and
division quotient/remainder, zero-divisor error and undefined-operation guards.

The accepted AST subset includes unsigned 32/64-bit locals and casts,
multiplication, division/remainder, bitwise packing, addition, constant logical
shifts, restricted branches and reviewed result constructors. Signed arithmetic, unsupported side effects, out-of-range shifts,
missing width assertions and unrecognized syntax refuse. Solver `UNKNOWN`
refuses. This check adds a semantic check of the actual native body to the
existing source/template certificate; it does not remove the template's
signature, layout, constructor or source-closure restrictions.

`npm run test:native-body` checks 27 report corruptions. Multiplication retains
three arithmetic mutations, four unsupported C forms, two equivalent forms,
forced solver uncertainty and six ASan/UBSan witness executions. Division adds
21 actual C mutations with native replays, four parser refusals, two equivalent
forms and injected UNKNOWN rejection. It also exercises process launch/timeout
logging, missing proof processes, successful processes that produce no report,
disabled assertions and command-wrapper failures. These finite fault replays
are distinct from the universal arithmetic queries.

The expanded six-leaf suite passed in the isolated candidate and was audited in
`build/wide-native64-scout/body-final-audit.json`. Fresh main-tree wide, handler
and six-leaf body qualification also passed, followed by a source/artifact/control
audit across 843 maintained files: `build/wide-native64-scout/main-focused-audit.json`.
The aggregate run covering this expansion and direct-key token composition is
being refreshed; earlier aggregate receipts predate those changes.

Reports bind the freshly generated source proof, actual C, frontend binary and
version, typed AST, checker sources and logs. The focused test archives its
initial receipt before failure controls retire conventional success paths.
`PYTHON` selects the proof interpreter; `SBF_TOOLS` selects the pinned frontend
binary directory. A changed frontend version or source/artifact hash refuses.

The source exporter, proof driver, Z3, Clang AST frontend, unsigned C data-model
interpretation and result constructor/layout interpretation remain trusted.
The AST proof precedes optimization: it proves neither Clang/LLVM passes nor
LLD, final SBF instructions, Solana runtime behavior, account authorization or
transaction rollback. Reports explicitly set `endToEndVerified` to false.

## Restricted SBF scalar model

`verification/sbf_machine.py` provides a maintained, deliberately restricted
SBPFv0 instruction model for translation-assurance work. Run
`npm run test:sbf-machine` with the documented Z3 5.1.0 Python environment
(`PYTHON` selects the interpreter).

The model handles straight-line MOV64, ADD64, MUL64, immediate left/logical-right
shifts, and aligned 64-bit loads/stores in one 4,096-byte stack frame. Scalar
inputs must be 64-bit bitvectors, uninitialized stack reads reject, r10 is
preserved, and scalar reads of the frame pointer reject. Other instructions,
control flow, non-stack memory and pointer arithmetic are outside its domain.
This module does not parse or validate ELF files.

The focused test checks eight universal algebra/frame properties, 200
40-instruction programs against a separate concrete integer evaluator, malformed
instruction/state refusals, preservation of caller-owned state, and rejection
under optimized Python. The test is separate from `verify:all` and `npm test`.
Its source-bound result is `build/sbf-machine-test.json`; a new attempt retires
the previous result before invoking Python.

These checks test the model. They do not prove its opcode interpretation against
a formal SBF specification or establish loader/JIT correctness. Z3, the model,
and the assumed valid/disjoint stack remain trusted. An experimental local
vesting proof uses this module with exact emitted instruction bytes, fresh
proof-gated reproducible builds and LiteSVM checkpoint tests. That fixture
pipeline remains under ignored `build/` directories and is not a maintained
whole-handler or end-to-end compiler gate.

`verification/sbf_cfg.py` supplies the accompanying structural graph projection.
It decodes instruction boundaries (including LDDW continuation words), checks
that edges target real instructions, and selects instructions both reachable
from an entry and able to reach an exclusive cutpoint. The selected graph must
have increasing instruction addresses on every internal edge; calls in that
region reject. Taken and fallthrough edges retain their ordering and identity,
even if they have the same destination. A consumer must interpret both edges
correctly or explicitly reject that case.

This is a structural projection, not an ELF loader or a complete execution
model. Call targets/returns are not modeled, instruction semantics still belong
to the consumer, and routes that cannot reach the cutpoint are excluded. No
termination or unconditional cutpoint-reachability claim follows. The same
`test:sbf-machine` command now checks 19 graph refusals, 12 independently
enumerated graphs, relocated diamonds, double-width instruction boundaries,
coincident successors, and the exclusive-stop convention.

`verification/sbf_paths.py` performs symbolic execution within that selected
acyclic graph. Callers supply initial register values, named immutable memory
regions and their byte sizes, a 32-bit word reader, and optional initial stack
values. Word reads are cached per region/offset and must fit their declared
region. The stack is a separate assumed valid frame. Pointer arithmetic,
pointer comparisons/stores, incompatible pointer merges, unsupported branches,
and coincident conditional successors reject.

Register merges use predecessor guards. Stack slots survive a merge only when
initialized on every predecessor; this deliberately rejects some safe but
unproved cases, including initialization only on a feasible subset of routes.
The executor returns a reachability guard and symbolic state without silently
assuming that guard is true. Applications must supply their own premises and
prove both their claims and nonvacuity. Region sizes and disjointness remain
caller assumptions, not allocation-safety proofs.

The focused gate includes seven universal path/state checks and 19 path-domain
refusals: diamonds, nested merges, conditional overwrites, uninitialized stack
reads at joins, pointer merges, cached zero-extending loads, region bounds and
invalid register states. The experimental vesting consumer uses context/state/
instruction sizes 56/128/112, checked by SBF-target C static assertions in each
fresh pipeline run, while its protocol premises and obligations remain outside
the generic module.

`verification/sbf_leaf.py` is a separate restricted domain for call-free leaves
with a write-only region named `output`. It supports typed pointer stack spills,
32-bit output stores, split 64-bit immediate stores, LDDW, bitwise OR and unsigned
`>=` branches. Output loads reject, so writes cannot be confused with cached
immutable inputs. Incompatible merged values become poison: copies and spills
may preserve it, but observable arithmetic, memory addressing and output stores
reject it. The caller must check the reachability guard and complete output
footprint; a word written on only one predecessor is not definitely initialized.
The stricter immutable path executor remains separate.

The focused gate adds nine leaf claims and 19 refusal controls covering store
overlap, pointer spills, output joins, comparison boundaries, immediate widths,
poison propagation, bounds and reserved fields. It also rejects optimized Python
and checks caller input preservation. The leaf instruction and memory model is
trusted, assumes valid disjoint regions, and excludes calls and general mutable
memory. The maintained `verification/check-sbf-division.py` driver stages the division
proof templates and this model into a fresh product qualification build. Run
`npm run verify:sbf-division` with the documented Z3 Python environment;
`SBF_DIVISION_OUTPUT` selects
an isolated output root (default `build/sbf-division`). It requires the same
pinned tools and prebuilt LiteSVM runner as the product gate.

This separate qualification checks four emitted division steps, nine composition
claims over their interfaces, a deliberate interface fault, and 73 isolated
LiteSVM executions (70 baseline cases plus fault/oracle controls). It creates a
fresh proof-gated vesting artifact and checks report, source and artifact hashes.
The four-step body has 229 modeled instructions before EXIT; the VM replay also
executes its return. Failed attempts retire the previous latest pointer and
retain failure evidence. `npm run test:sbf-division` runs the model checks, a fresh
qualification, four actual process failures (missing Python, zero exit without
JSON, optimized Python and missing tools), and 98 report-corruption refusals.
The validator checks exact claim identities, input inventories, complete step
reports, distinct baseline cases, expected fault outcomes and the replayed body
against the emitted bytes. The focused gate and all 42 aggregate entries passed with zero recorded source
drift; see `build/overnight/sbf-division-main-all42-terminal.json`.
It proves neither source extraction nor the larger division routine/caller,
whole-handler behavior, or a verified compiler.

A separate maintained `verification/check-sbf-quotient.py` driver now stages the
larger arithmetic chain from `verification/sbf_quotient/templates.json`. It runs
a fresh division-leaf prerequisite and then the twelve inline steps in `div16`,
its stack-record/callee bridge, the caller's four-call restoring sequence, route
and product-entry bindings, and exact substitution of restoring-step summaries.
The current router separates divisor-one, zero-high native division, nonzero-high
128-by-32 division when the denominator high limb is zero, and restoring
division otherwise. Native register DIV is explicitly enabled in
the leaf interpreter and requires a proved nonzero divisor at every reached
DIV instruction; SAT and solver UNKNOWN reject. A recorded local executor
extension models the small branch’s register MUL under the same field/scalar
checks. Its universal argument/packing identities include arbitrary unobserved
upper limbs; both DIV obligations discharge from the actual clock guard. The
product-entry bridge binds those clock spills to checked entry inputs and checks
that intervening instructions preserve them. The 68 integer induction obligations,
native/restoring bounds and four two-division Euclidean composition claims run
freshly. Its default
output is `build/sbf-quotient`; `SBF_QUOTIENT_OUTPUT` selects an isolated root.
Run `npm run verify:sbf-quotient` with the documented pinned Python environment.
`npm run test:sbf-quotient` adds the model tests, four actual process-failure
controls and 304 report-corruption refusals. The current focused command passed;
its receipt is `build/sbf-quotient-test.json`. Failed attempts retire old success
pointers while preserving their bytes and failure evidence.

This qualification also runs thirteen emitted-instruction fault controls,
96 helper/fault VM executions and 191 caller-checkpoint VM executions. The caller
checkpoint compares 182 valid inputs across all four routes against Python's
independent 128-by-64 quotient, with six instruction-fault refusals and three
invalid-domain refusals. It also checks saved context and deferred flag. The former
102-case corpus is retained, with 80 small-divisor boundary/random cases added. It supplies
entry limbs through instrumentation; it is not a deployed whole-handler test.
The qualification still trusts the restricted interpreters, Z3, valid disjoint
memory and the SBF call ABI, source layout, and unsigned/integer interpretation.
The driver enforces exact proof and execution inventories, expected solver
results, artifact hashes and prerequisite bindings. It is registered as the 43rd
aggregate entry. The historical 43-entry run passed with zero source drift
across 633 maintained files; see
`build/overnight/sbf-quotient-main-all43-terminal.json`. The earlier division-optimization gate had 14 reports, nine phases and 271 report
refusals (`build/sbf-product-refresh/quotient-main-audit.json`). The current
four-route refresh passes 15 reports, ten phases, four process failures and 304
report refusals; its read-only terminal hash audit is
`build/overnight/quotient-refresh-20261006/focused-current-terminal-audit.json`.
The full current 55-command aggregate remains pending a fresh run after the
handler/call-frame updates described below.
Historical aggregate receipts do not establish acceptance of these later changes.
This result covers the conditional quotient qualification, not complete handler
output or application/account effects.

`verification/sbf_output.py` is a separate restricted model for native output
construction: typed pointers, bounded word-addressed stack/input/output regions,
partial writes, and an explicit caller-selected memory-clear summary. It rejects
uninitialized or output reads, input writes, malformed regions, unsupported calls
and symbolic branches. The summary assumes zero-fill behavior, output-only writes
and SBF call preservation; these are not verified syscall semantics.
`npm run test:sbf-output` checks six algebra properties, 200 independent byte-memory
programs, 37 refusals, optimized-Python rejection and caller-input preservation.
A separate maintained `verification/check-sbf-handler.py` driver now stages
17 handler-check templates after a fresh quotient qualification. It checks native
dispatch, payout and authorization conditions, retained frame values, output
construction, target layouts, and the emitted memory-clear wrapper. The native
VM comparison runs 520 baseline cases and sixteen fault comparisons against all
360 output bytes, preserving the original instruction bytes and recreating the
checked `sol_memset_` relocation. Its fresh run with strict report validation passed.

Run `npm run verify:sbf-handler` with the documented pinned `PYTHON`;
`SBF_HANDLER_OUTPUT` selects an isolated directory (default `build/sbf-handler`).
The output model test runs first. Reports bind original and staged sources,
tools, prerequisites and logs. Strict schemas check all 17 report inventories,
solver results, layouts, VM outcomes and reviewed replay instruction bytes.
The current 302 report-corruption controls passed, including a changed instruction body
with its file hash recomputed. `npm run test:sbf-handler` combines a fresh public
qualification with model tests, those report controls and four actual process
failures (missing Python, empty successful output, disabled assertions and
missing tools). The focused public gate passed; its receipt is `build/sbf-handler-test.json`.
The handler is now
registered as the 44th aggregate entry. All 44 checks passed, with no recorded
source drift; see `build/overnight/sbf-handler-main-all44-terminal.json` and its
adjacent audit. This result predates the staged sequential token-frame work.
Its proofs remain conditional: they do not establish an end-to-end source/native
handler theorem or account validation, effect execution and transaction commit.

`verification/sbf_elf.py` extracts the executable `.text` section from the
pinned ELF64 little-endian SBPFv0 representation. It checks identity fields,
header and section-table bounds, the section-name string table, unique
executable/nonwritable PROGBITS text, instruction alignment and address bounds,
and that text bytes do not overlap the inspected section metadata. The focused
model gate includes 35 malformed-artifact refusals and a positive relocated-text
case. The same extractor checks the experimental chain's compiled input and
instrumented LiteSVM checkpoint binaries.

This extractor does not establish complete ELF validity, program-header mapping,
entrypoint correctness, relocation semantics, call targets, loader acceptance,
or JIT/interpreter correctness. These remain separate obligations. A successful
extraction only supplies the stated virtual address and exact section bytes to
the restricted instruction models.

## Conditional SBF product artifact gate

`npm run verify:sbf-product` runs the maintained fixture pipeline from
`verification/sbf_product/` using the documented Python/Z3 environment. It needs
the pinned Bend checkout, Bun, Anza tools and an already built
`target/debug/bend-test-runner`. `SBF_TOOLS` selects the pinned LLVM tools directory;
`PYTHON` selects Python. It is the 41st command in `verify:all`, and remains separate from ordinary
`npm test`. `npm run test:sbf-product` combines the focused model checks, a fresh
qualification, nine carry-model/boundary controls, four actual process-failure
controls, and 70 report-corruption refusals. Its evidence is
`build/sbf-product-test.json`. Product and division focused receipts preserve
their model report inside the individual run, so a later model test cannot
invalidate that receipt's report path.

Every attempt retires its previous success pointer, creates a UUID source
snapshot, and makes a clean sparse Bend checkout using the existing local Git
objects. It invokes the normal public source/proof/build gate, then checks the
emitted C/ELF identity, target field layouts and region sizes, native-entry
operand correspondence, arithmetic block composition, final product registers,
and 78 instrumented LiteSVM checkpoint executions. It validates report contents
and bound files before publishing `build/sbf-product/latest.json`. Failed attempts
retain their logs and a failure record; no historical fixture binary or ignored
probe script is a prerequisite. Sparse checkouts use the original dependency's
Git objects, so keep that dependency while retaining these run directories.

Maintained templates are copied into each isolated run's `build/` layout before
execution. They are source files; run copies and reports are generated artifacts.
The source inventory and fixture-specific instruction addresses/claims are
explicit: compiler or fixture changes that invalidate them must fail and receive
review, rather than silently regenerating expected theorem results. The public
driver also checks staged sources and shared dependencies for drift.

The claim remains conditional on the native ABI, valid disjoint memory,
source-field interpretation, restricted machine models and Z3. It covers the
vesting entry-to-product path (251 original instructions in the checkpoint
harness), not whole-handler division/results, account effects/commit, all
compiler inputs, or loader/JIT correctness. The templates retain narrow proof
scopes for their individual intermediate results. This command is maintained
translation-assurance evidence, not an end-to-end verified compiler.

The current product profile uses a 29-instruction prefix, a 49-instruction
carry block, and a 20-instruction suffix. Its restricted carry interpreter
admits a forward skip over an immediate assignment and its matching stack
store only when the skipped slot already has a modeled value. The carry flag's
required incoming value of 1 and the start-high stack word are connected to
actual entry-path memory by the full register/stack boundary proof. They are
not extra application premises. Direct controls check both conditional-store
paths, malformed shapes, a wrong skip target with an integer counterexample
replay, an incorrect incoming carry, entry-path binding, and UNKNOWN refusal.
Compiler output, source timing/amount domains, and query limits are unchanged.

## Nat-ranked loop translation checks

`npm run verify:ranked-lowering` checks the default emitted C against exported
checked-source semantics for `examples/batch/PROOF.bend` (`batch.process`) and
`tests/iteration.bend` (`count`, `swaps`, `toggle`, `rotate`), plus
`examples/queue/PROOF.bend` (`queue.process`, `queue.select`). The gate covers
165 reachable function instances with 179 obligations, including seven
self-recursive loop specializations. Each loop has separate source and C unsigned-Nat decrease
obligations, followed by result-equivalence and safety obligations. Smaller-rank
recursive calls and C continuations share an arbitrary summary; the trusted
driver composes the results by well-founded induction and dependency order.
The rank domain includes all admitted fuel values 0–64. This is not a CU bound.

The restricted interpreter admits a single outer `for (;;)` with explicit tail
continuations. It rejects mutual recursion, nested loops, direct recursive C
calls, and unsupported control flow. Feasible loop-body fallthrough is a safety
failure. Scalar Boolean parameters use the emitted C's unsigned storage, with
canonical Boolean checks at typed boundaries. Simultaneous argument updates
are checked from the actual sequence of temporary declarations and assignments.

`npm run test:ranked-lowering` additionally exercises 25 semantic/structure fault
controls, 29 report-corruption refusals, and four controller failures. Its native
comparisons cover 120 batch cases and 975 iteration cases against independent
expected results and checked Bend execution, plus 168 queue decision and 288 queue selector
cases under ASan/UBSan; fifteen terminating C faults must produce mismatches.
Queue selector cases use an independent nonwrapping range oracle. Queue
decision cases compare full outcomes with checked Bend and independently assert
authorization, terminal-state and boundary acceptance/rejection expectations. Failed controllers archive prior evidence and
leave no fresh-success receipt. The successful gate receipt binds the complete
source inventory, exported input, frontend checks, and exact proof report.

These are conditional pure source/C translation checks. The exporter, restricted
interpreters, schema/layout interpretation, induction driver, and Z3 remain
trusted. They do not establish account-adapter correctness, token execution,
rollback, pointer/memory isolation, LLVM preservation, or SBF preservation.
Native cases are finite tests, separate from the universal SMT obligations.

## Signed-width linear caller composition

`npm run verify:linear-width` compares the SDK-backed `benchmarks/linear.bend`
with its retained wide-arithmetic reference, `benchmarks/linear-wide.bend`.
It first qualifies the signed SDK, binds all twelve imported function definitions,
then checks byte-product equivalence, bounded accumulation, invalid-input validity
propagation, the actual ordered 32-step fold, and the final-output relation.
The stages contain 21 UNSAT obligations and three SAT negative controls.
The unchanged downstream arithmetic closure is bound structurally.

This is a source-level composition argument with a trusted exporter, interpreter,
induction driver and Z3. It is not a whole-caller C or SBF preservation proof.
`test:linear-width` runs the fresh chain and 47 report-corruption refusals,
including stale dependencies, missing claims and incomplete fold evidence.
Four process controls cover missing Python and targeted linear-child empty output,
nonzero exit and disabled assertions. Failed runs archive the prior receipt and
leave no fresh success; a fresh positive run restores it. Three exported-source
mutations (accepting invalid output, duplicating a fold input and incorrect initial
validity) must produce SAT at the intended claim. These are model mutations, not
compiled witness replays; signed SDK native controls remain a separate command.
The caller command is registered in the 47-entry aggregate; a full 47-entry
aggregate pass has not yet been established. Receipts bind their exact snapshots.


### Integrated 47-command snapshot and queue extension

The complete 47-command aggregate passed with no source drift across 727 recorded
files. Its terminal receipt is `build/overnight/integrated-all47-terminal.json`;
archived child reports are bound by `integrated-all47-evidence.json` in that
folder. This includes the signed-width and linear caller gates, the issuance
sequence checks, and the existing SBF artifact gates. It is not a full `npm test`
run or an end-to-end compiler theorem.

The subsequent queue process/selector extension passed the full ranked suite in
an isolated source copy before promotion. The fresh main `test:ranked-lowering` subsequently passed the complete expanded
suite, including report/process controls, semantic mutations and native replays.
`build/queue-integration/main-audit.json` binds its inputs and evidence. The
47-command snapshot still does not retroactively validate these later edits.

### Connected collection root gate

`npm run verify:collection-root` freshly runs the collection composition gate,
then qualifies the actual default emitted C for `tests/collection-store.bend`'s
`process` and `select` roots. It connects validated codec semantics to the parsed
caller: instruction/state/record decoding, selector inputs and outputs, root
window inputs and outputs, and encoded state/record bytes. The fixture selects
one record per call. Its second record slot and root rejection payload are
unreachable; their bindings do not establish a two-record guarantee.

The gate checks 26 pure C function instances, 183 caller obligations and 33
ordered output bindings. Additional checks cover constructive binding extension,
pure-call safety, malformed input refusal, canonical state encoding and a
modulo-U32 call-counter increment. Success witnesses prevent all paths being
refused from counting as a valid result. Three deliberately invalid window
operations reach the root but cannot commit.

The controller retires the prior receipt before starting. It publishes
`build/collection-root/fresh-receipt.json` only after successful child processes,
strict report inventories, exact artifact bindings and source-drift checks.
Its process/report qualification passed on the snapshot recorded in
`build/collection-root/process-controls.json`: four targeted failures and 37
report-corruption refusals, followed by a restored positive run.

`npm run test:collection-root` additionally runs the native adapter and
byte/selector comparisons and the binding sensitivity controls. The full focused
command passed: 160 native adapter cases, 61,440 byte/selector cases, six native
fault replays and 29 binding controls, with seven unreachable binding guards
recorded separately. Native comparisons use ASan/UBSan and independent expected
bytes/ranges. Its report is `build/collection-root-test.json`; the source and
artifact audit is `build/collection-root-scout/full-audit.json` (546 maintained
inputs). The new proof command is aggregate entry 48. All 48 commands passed on the 741-file snapshot in
`build/overnight/all48-0159ab8b-3913-49c6-9a5e-1ac91297409b/terminal.json`,
with zero source drift. The earlier 47-command result remains evidence
for its own snapshot.

Assumptions include checked-source/C models, Z3 and proof drivers, codec-template
interpretation, context construction, loader byte provenance, valid disjoint
native objects and helper contracts. Native tests bypass serialized entrypoint
loading and stub clock/return-data syscalls. These results do not establish a
general memory-write theorem, token effects, rollback, LLVM preservation or
end-to-end SBF correctness.

### Conditional account decoder gate

`npm run verify:loader` qualifies the current `runtime/solana_min.h` through a
closed declaration/signature profile and a restricted model of the parsed
`read_account` statement template. The model also interprets the parsed `read_le`
loop for the eight-byte calls used by this decoder. It checks 26 claims covering
little-endian values, duplicate refusal, guarded read bounds, descriptor field
addresses/flags/length, rent and successor addresses, nonwrapping intermediate
arithmetic, and alignment. A successful decoding witness prevents vacuity.
The syntax gate checks the header and the assumed 64-bit pointer width with the
selected host C frontend. Unsupported declarations and statement forms reject.

The required source inventory includes the model, profile, report validator,
controller and parser modules. The report binds the exact header, source hashes,
input, frontend binary and syntax unit. The controller retires any old success
receipt before work and only publishes a fresh one after independent report
validation and source/artifact checks.

`npm run test:loader` passed 1,239 ASan/UBSan native cases, four native fault
controls, 11 semantic counterexamples, five grammar refusals, four process
failures, 18 report corruptions and 15 malformed-input/source-inventory controls.
Native cases cover padding boundaries, account lengths through 10 MiB,
nonuniform scalar/key bytes, flags, duplicate markers and two-account cursor
chains. They check unchanged serialized input and unchanged descriptors on
refusal. Evidence is `build/loader-test.json`, with the exact source/artifact
audit in `build/loader-scout/main-audit.json`.

This is conditional template-model assurance, not an arbitrary C interpreter.
The loader's valid aligned allocation and authentic serialized metadata remain
assumptions, as do 64-bit address casts, byte-memory semantics and disjoint native
descriptor objects. Native tests use contiguous buffers; VM region mapping,
loader/JIT behavior and SBF preservation are not established. The decoder gate
is now registered in the 50-command aggregate: the earlier integrated 48-command result predates this
addition. Adapter proofs still contain their existing loader summary assumptions;
this new result has not yet been composed into those caller models.

### Serialized collection entry composition

`npm run verify:collection-entry` refreshes the conditional loader and collection
root prerequisites, then checks their connection over one serialized byte array.
The maintained driver is `verification/check-collection-entry.ts`; its restricted
models and exact report contract live in `verification/collection_entry/`.
`npm run test:collection-entry` additionally exercises process failures and report
corruption. The maintained focused gate passed, including four process controls and 52
report-corruption controls. Its audited receipt is recorded in
`build/collection-entry/main-audit.json`.

The fixture remains `tests/collection-store.bend`. The gate connects entry dispatch,
account metadata, state/instruction bytes, stored collection header/key/length,
the quantified full-allocation zero predicate, selected record bytes and the
previously checked source-to-C roots/codecs. It checks 99 distinct binding outputs
with constructive extension and rejects cyclic/duplicate output bindings. Its
selector activates at most one record; second-slot claims are explicitly inactive.
It also requires a 171-case native serialized-entry baseline under ASan/UBSan and
five deliberate entry/record-pointer faults, using the same generated artifacts.

These are conditional fixture checks. Loader allocation validity, native object
separation, memory provenance, qualified helper contracts, proof drivers, parsers
and Z3 remain assumptions. Some universal obligations deliberately drop an
unneeded quantified premise; successful initialization is checked separately
against the full predicate. Native syscalls are stubbed. This gate does not prove
arbitrary programs, complete post-commit memory behavior, C-to-SBF preservation,
VM mapping, syscalls or transaction rollback.

Inputs and compiler identity are captured before execution. Nine required child
reports are checked against fixed inventories and exact artifacts before an
atomic receipt is published at `build/collection-entry/fresh-receipt.json`.
A failed run retires the previous receipt and cannot reuse it as current evidence.
The focused test report is `build/collection-entry-test.json`. The loader and
collection-entry gates are included in the 50-command aggregate. All 50 checks
passed with no source drift across 770 recorded files; the archived report and
source hashes were independently audited in
`build/overnight/all50-6148675f-2505-4e75-bc56-57f7b3764e68/audit.json`.
This receipt covers its recorded snapshot and the documented conditional scopes.

### Collection memory and generated state writes

`verify:collection-memory` refreshes the serialized-entry prerequisite, then
checks a conditional global byte-array model for the collection fixture. Its
models and exact report inventories live in `verification/collection_memory/`.
`test:collection-memory` adds process-failure and report-corruption controls.
The maintained focused gate passed with fresh loader/root/entry prerequisites,
four process-failure controls and 45 report-corruption controls.
`build/collection-memory/main-audit.json` records the subsequent source, receipt,
child-report and native-artifact audit, including strict prerequisite validation.
This audit reuses the maintained validator; it is not an independent semantic proof.

The package connects the three-account serialized layout to commit destinations,
models the complete bounded record/header/length/key write sequence, proves a
state-key read invariant across commit stores, discharges the helper precondition
from the qualified caller, and models the generated 20+5 state copies. These
copies store the source result (including modulo-U32 counter behavior) and
preserve committed collection bytes. Zero-, one- and two-record helper writes
are checked; the source fixture itself still selects at most one active record.

Native evidence uses the actual loader/commit helper in 771 whole-buffer cases,
including boundary allocations up to 10 MiB, with four deliberate faults. A
separate 171-case generated-entry baseline detects two state-copy faults. Fixed
report inventories and reconstructed native source/mutation bytes are checked
before publication of `build/collection-memory/fresh-receipt.json`.

The byte-array and finite-sequence composition uses trusted proof drivers and
parsers. It assumes valid contiguous loader allocation and native address casts,
stable local scalar/descriptor objects, and disjoint scratch/header objects.
Local descriptor preservation is tested natively; this is not a formal C-object
provenance or VM-memory theorem. Return syscalls, external effects, rollback,
Clang/LLVM preservation and general SBF execution remain outside the result.
The 50-command aggregate passed before this standalone gate was introduced;
its historical receipt does not qualify these new files.

### SBF memory-clear byte/word connection

The maintained `verification/check-sbf-zero-fill.py` proves six conditional
BV64/byte-array claims: interval nonwrap, outside-byte preservation, empty-fill
identity, inside-word zeroing, outside-word preservation and agreement of interval
membership across each aligned word. Premises include a region of at most 1,536
bytes, four-byte alignment and address headroom. Syscall byte-fill/frame behavior
remains assumed; this does not verify the syscall implementation.

`npm run test:sbf-zero-fill` compares the actual output interpreter for every
supported length at both region edges (769 cases). Four interpreter mutations,
optimized Python and injected solver UNKNOWN are refused, alongside 16 report
controls. The handler gate now runs this proof afresh and connects four clear
instances to the same ELF as the checked wrapper, with exact call targets,
intervals and model hashes. The full focused handler test passed with 13 new
connection refusals and its 17 phases, 520 baseline VM cases, sixteen fault
comparisons, four process controls and 302 phase-report refusals.

Evidence is `build/sbf-handler-test.json`; the subsequent source/artifact audit
and strict validator replay is
`build/overnight/quotient-refresh-20261006/handler-focused-current-terminal-audit.json`.
The earlier `build/sbf-memory-scout/main-audit.json` records its preceding snapshot.
Valid disjoint allocation, syscall behavior, VM CALL semantics, models/parsers
and the solver remain trusted. This is not a whole-handler memory theorem or an
end-to-end compiler proof. The earlier 50-command aggregate predates this change.

### Conditional SBF call-frame connection

The public call-frame verification command builds a fresh qualified handler and
captures its receipt. The maintained verification/sbf_call_frame package checks
all syntactically reachable memory accesses in the recorded div16/div4 bodies:
676 and 230 instructions including exits, and 157 accesses. Its conservative
acyclic provenance analyzer tracks scalar values, pointer spills and initialization.
Ambiguous values cannot serve as addresses. Writes must stay in the local frame
or declared 40-byte output; the nested call's pointer arguments are checked.

Six BV64 layout claims establish conditional fixed-frame separation. Six further
queries map every extracted write into enclosing frame/output regions and show
that all six recorded short/full call instances preserve 14 pending caller words.
Coverage is checked for every write before querying separation. Premises include
4,096-byte frames, strides of 4,096 or 8,192 bytes, bounded depth and address
headroom. Matching pinned VM source snippets binds the intended model; it does
not prove Rust, JIT or VM semantics.

The first maintained focused gate passed with fresh handler evidence, four
actual-byte mutations, three SAT frame controls, four process-failure controls
and 24 report refusals. build/sbf-call-frame/main-audit.json records its
source/artifact audit. The reusable-model refactor also passed full focused
qualification: three accepted synthetic cases, 14 refusals and an optimized-Python
refusal are included. The current audit binds 16 source files and all child and
model evidence; the initial audit is preserved as initial-main-audit.json.

The abstract interpreter, proof drivers, solver, VM CALL/register behavior and
valid address mapping remain trusted. This covers selected arithmetic callees
and retained caller data, not arbitrary SBF programs or whole-handler memory
safety. The historical 50-command aggregate predates this standalone gate.

The expanded 52-command aggregate now includes collection-memory and
SBF call-frame verification. The integrated retry passed all 52 commands with
806 unchanged maintained source hashes. The archived reports and source inventory
were audited before later edits: `build/overnight/all52-f01e97a6-bc30-47eb-a3c9-e4dd8e8ad817/audit.json`.
Receipts remain evidence for their own recorded snapshots.

The first expanded aggregate stopped on a 10-second frame-connection solver
timeout, not a counterexample. Its failure evidence is preserved. The maintained
connection now queries byte-address inequality and algebraically cancels the
common stack base, covering all bytes in the same enclosing write regions.
It retains the arbitrary base and original timeout. The bad-output-binding
control uses the same predicate builder as the six positive checks. The full
focused gate, source/artifact audit and aggregate retry passed after this change.
No UNKNOWN result is counted as a proof.

### Multi-account token frame qualification

`verify:multi-token-frame` freshly emits the two-, three-, and four-state token
fixtures and substitutes the parsed token validator's result for each effect
slot in the emitted-adapter model. It checks the existing caller ordering and
commit contracts, the reviewed executor body and its actual writable-account
list, and preservation of arbitrary managed-account bytes at each executor call.
Six satisfiable initialization/update cases require both transfer slots active
and all key-representation/identity premises enabled.

`test:multi-token-frame` also exercises 36 native ASan/UBSan sequences and six
pending-buffer faults with actual generated root, codecs, extraction and token
helpers. Syscalls are stubbed. Sixteen altered-report/manifest controls, four
controller failures and one public-wrapper launch failure check fail-closed
reporting, followed by a fresh successful restoration.

The maintained public focused gate and source/artifact audit passed. Evidence is
`build/multi-token-frame-test.json` and `build/multi-token-frame/main-audit.json`;
the audit binds 351 sources and the restored receipt, all 16 report controls,
four controller controls and the wrapper launch-failure control. The earlier
52-gate aggregate predates these additions. This gate and the composition gate
below are registered in the 54-command aggregate; its integration run and
post-terminal source/artifact audit passed on the recorded snapshot.

The token-frame model now uses full 256-bit keys shared by identity comparisons
and byte reads, removing its separate abstract-key encoding/reflection premise.
The updated main focused qualification passed; its audited source snapshot,
restored receipt and failure controls are preserved in
`build/full-key-token-frame/main-focused-0507a8a6-cd1f-4c1f-8d41-385be2b90f95`.
The earlier aggregate above does not qualify this later change; a fresh aggregate
is pending.

The formal account-byte frame assumes different Bend
and token-program identities, stable metadata, valid disjoint native objects and
runtime enforcement of writable CPI accounts. The executor check is complete-body
conformance to a reviewed model, not general C semantics. The adapter model keeps
an abstract application root and uses the existing structural extraction check.
Native tests establish finite behavior; they do not prove SPL semantics, SBF
execution or transaction rollback. Later token-state predicates can change even
when pending local buffers and managed state remain intact.


### Multi-account token composition qualification

`verify:multi-token-composition` connects the actual emitted roots and codecs of
three two-, three- and four-state fixtures to extracted token effects, parsed
validator results, executor preconditions and adapter commit ordering. The
successive token-write model checks durable validation, decimals and arbitrary
managed bytes needed by later calls. Six satisfiable initialization/update cases
exercise both transfer slots. Source/C amount mapping includes three deliberate
wrong-source mutations; managed-byte and decimals corruption controls use the
same model as the positive checks. Positive proofs reject witness pins.

The earlier abstract-key model passed `test:multi-token-composition`: fresh qualification,
28 report controls, 11 input controls, five controller process failures, one
public-wrapper launch failure, and a fresh successful restoration. The native
pending-buffer driver exercised 36 sequences and six faults on these freshly
emitted artifacts. Its syscalls are stubbed; it does not establish runtime rollback.
The post-terminal audit binds 368 source files, exact artifacts, restored receipt
and all failure controls: `build/multi-token-composition/main-audit.json`.
Focused report SHA-256:
`4b7f52b92de065b658c9b8c0e5daecfc28be7ab684c5dd63fc85709319ff9d7b`.

The current model uses the same full 256-bit values for account identity, owner
identity and key byte views, removing the separate encoding/reflection premise.
An isolated prototype passed all three positive fixtures and six expected frame
faults without changing the exact positive claim inventory:
`build/full-key-composition/extended-audit.json`. Maintained public qualification
and post-terminal audit also passed, including 28 report controls, 11 input
controls, five controller failures, one wrapper failure, native replay and fresh
restoration: `build/full-key-composition/main-audit.json` binds 368 source files.
Focused report SHA-256:
`b4a583bb60bbaa8c0ff560fda18f014732bcbe0fc44a5fd8f9fe46891b4c370e`.
The earlier focused and aggregate receipts above/below predate this change.

The model still assumes distinct program identities, stable metadata,
valid/disjoint native objects, local-buffer isolation and runtime
enforcement of the token mutation frame. The parsed executor is checked against
a reviewed complete-body model. Custom parsers, exporters, proof drivers and Z3
remain trusted. This connects the selected fixtures under these assumptions;
it is not a general C memory-safety, SPL semantics, LLVM/SBF preservation or
transaction-rollback proof. The expanded 54-command aggregate passed with 835 unchanged maintained source
files. Its post-terminal audit is
`build/overnight/all54-14fc7ab7-a718-4ebe-8132-958d3efad938/audit.json`;
aggregate SHA-256 is
`1a346223003b452e24d2422d40bc35a9e4cdbf2202f555559775ec3992593745`.
The 54-command and previous 52-command successes each apply only to their
recorded input snapshots.

### Earlier native-u64 optimized handler qualification

After the native-u64 division optimization, the maintained handler gate was
refreshed against the newly emitted vesting image. `test:sbf-handler` passed
17 phases, 448 baseline whole-native-output VM cases and ten fault comparisons,
291 malformed-report refusals, four process-failure controls and 13 zero-fill
connection controls. Evidence and current bindings are audited in
`build/sbf-product-refresh/handler-main-audit.json`. The three quotient routes
preserve the authorization flag and required accounting/output inputs; output
construction checks all 90 words, with 15 retained words feeding the accepted
claim suffix directly or through live registers. The replay preserves 1,693
original instruction words across the handler, arithmetic helpers and memset
wrapper. Solver outcomes and independent expected VM records were unchanged
by this refresh. The surrounding conditional-model and runtime assumptions
still apply; this focused success does not certify the full aggregate or an
end-to-end compiler theorem.

The dependent call-frame qualification has also been refreshed for the optimized
image. Its actual callee footprints retain the same 230/676 instruction and 157
access inventories at relocated addresses. Four restoring calls preserve fifteen
pending words under the existing fixed-frame/CALL assumptions. The focused gate
passes its model, process and report controls; current evidence is
`build/sbf-product-refresh/call-frame-main-audit.json`. Older six-call/fourteen-word
inventories describe the preceding compiled image.

### Current four-route handler and call-frame qualification

The current vesting image also takes a 128-by-32 route for small divisors with a
nonzero high dividend. Maintained handler qualification now covers all four
quotient routes and their current dispatch, payout, authorization, output and
memory-clear instruction profiles. `npm run test:sbf-handler` passes 17 phases,
520 baseline whole-native-output VM cases, sixteen fault comparisons, 302 report
refusals, four actual process failures and thirteen clear-connection refusals.
The original 448 baseline cases and expected output bytes remain unchanged;
72 cases add small-divisor boundaries, clock wrap and payout/claimed boundaries.
Three new instruction faults target both small-route divisions and the intervening
multiplication. Complete 360-byte outputs are compared using independent expected
records, preserving 1,763 original instruction words and the checked relocation.
The Claim suffix checks all ninety output words. Its frame has fourteen retained
output inputs; the quotient spill is bound separately. The deferred unauthorized
backward edge uses the actual mask, branch direction and target, with permanent
inverted/redirected/wrong-mask refusals. The shared acyclic output model is unchanged.
Current terminal source/artifact and strict-report audit:
`build/overnight/quotient-refresh-20261006/handler-focused-current-terminal-audit.json`.

The call-frame gate requires the output, payout and authorization frame reports
from the same freshly qualified handler image. Four restoring calls preserve the
union of seventeen pending words. The actual division bodies still have 676/230
instructions and 157 accesses. `npm run test:sbf-call-frame` passes three synthetic
positives, fourteen model refusals, four process failures and thirty report
refusals. Six targeted controls omit each kind of pending word or its required
frame binding; each rejects for the expected inventory reason. The same byte-range
separation predicate also rejects an output bound onto a pending field.
Evidence: `build/sbf-call-frame-test.json`; terminal audit:
`build/overnight/quotient-refresh-20261006/call-frame-current-terminal-audit.json`.
Fixed-frame mapping, valid memory, restricted models, solver and VM/CALL/syscall
contracts remain trusted. These focused passes do not establish an end-to-end
compiler, whole-handler memory or account-commit theorem. The complete current
55-command aggregate still requires its own fresh run.

### Application prerequisites after native64 wide division

AMM pricing, AMM, vesting entrypoint and exchange independently export the math
division closure as well as multiplication. The wide proof checks imported callee
identity, nine integer width-bridge obligations, and eleven named API obligations
covering error precedence, divisor-one, native64 and restoring routes, composition,
and floor/ceiling. Application consumers reject a different API claim inventory.
Focused application validation after this binding update is recorded in
`build/sbf-product-refresh/application-amm-pricing-audit.json` and
`build/sbf-product-refresh/application-wide-f1d62cc4-d261-4a1f-9e83-f268720cca70/audit.json`;
it does not itself establish a full aggregate pass or an end-to-end compiler proof.

### Serialized token physical-memory composition

The maintained multi-token composition gate now connects serialized initial
views and guarded helper preservation to physical commit writes for the two-,
three- and four-state fixtures. Shared lemmas are proved in the same qualification
and reused only after exact parsed-query and source/run binding checks. Selected
helper memory is passed directly into finite-store induction. Details and trust
assumptions are in `docs/adapter-assurance.md`.

Initial qualification and 60 report/11 input/five process controls passed. The
focused command's restoration timed out in a token-four full-root solver query;
it did not publish success. A fresh unchanged public qualification passed and
was audited against the completed controls, including wrapper failure evidence.
`build/token-loader-scout/physical-recovered-qualified/` records that recovery
and the original failure separately. This is conditional fixture-level evidence;
no whole-compiler, arbitrary SBF, SPL accounting or transaction rollback theorem
is established. Broader aggregate verification of this snapshot remains pending.

### CPI physical-frame component

`npm run test:cpi-physical-frame` checks the maintained U64 byte-frame component
in `verification/cpi_physical/`. It distinguishes writable serialized account
regions, disjoint private helper/syscall workspace, and the exact successful
helper stores to caller `Account.size` fields. Returned account-info lengths are
read from workspace bytes; consistency with serialized lengths and allocated
capacity is an explicit runtime/ABI premise. The workspace must contain the
helper/syscall writes and remain disjoint from caller descriptors, account
arenas, pending reply/state buffers and both effect records.

Fresh qualification passed 34 independently replayed SMT queries, reconstruction
of all 96 descriptor size-byte stores, 24 actual-helper ASan/UBSan scenarios,
five semantic helper mutants and their grammar refusals, and 16 altered-report
refusals. Host execution and pinned Anza SBF compilation check the descriptor,
account-info and effect layouts. Concrete high-address allocation witnesses
cover 128-to-192 growth and 128-to-32 shrink. Missing workspace separation,
managed writable exclusion, returned-length capacity and size-refresh premises
have counterexamples. Evidence is `build/cpi-physical-frame/focused.json`;
the source/artifact audit is
`build/cpi-physical-frame/run-44a4520a-a506-4495-aca0-eeafbfb66de6/terminal-audit.json`.
The latter records 725 unchanged source bindings and 63 audit bindings.

Boolean/BV/array/Lambda syntax fingerprints avoid repeated expression-tree
expansion. They identify syntax rather than truth: source and serialized-query
fingerprints are distinct, their serialization equivalence is checked, and
proof-cache reuse additionally requires exact source AST identity. The focused
gate tests changed operators, widths, values, symbols, argument order,
declaration parameters and binders; unsupported forms reject explicitly.

The frame-query solver expands selects over conditional arrays before SMT,
without changing the asserted model, premises, serialized queries or structural
fingerprints. Independent raw-query replay uses the same semantics-preserving
preprocessing in a fresh context. The 30-second solver limit is unchanged.
Report validation checks complete inventories and metadata before traversing
raw DAGs; every accepted report still reads, hashes and fingerprints every
query afresh. Rejection controls retain their 60-second process limit.

This is a maintained component gate. The additional full caller connection
below has its own evidence. Broader regression and current full55 qualification
remain pending. Allocation, workspace containment, runtime capabilities, truthful
metadata, the restricted helper grammar, proof drivers and Z3 remain trusted.
Native syscalls are doubles; SBF compilation checks layouts only. These results
do not prove external rollback, LLVM/SBF preservation or an end-to-end compiler.

### Maintained caller-to-physical CPI connection

`npm run verify:cpi-physical` freshly exports the actual two-, three- and
four-state CPI callers and connects their checked roots, codecs, effect
extraction, custody and parsed execution/count gates to both physical helper
steps and actual commit stores. The model includes private helper workspace,
truthful capacity-bounded returned lengths, successful descriptor refresh and
conditional readonly serialized-length preservation. Pending headers, encoded
states, reply bytes, both effect records, managed data, keys and descriptor
pointer/flag bytes have explicit physical origins and exclusion instances.
The final refreshed helper memory is the input to finite physical Store
induction over the actual parsed commit writes. Early/helper failure paths
perform no adapter commit; external-account rollback remains a runtime premise.

The new driver and auditor are maintained in `verification/cpi_physical/`.
Each completed three-fixture qualification replays 374 raw SMT queries. Native
checks execute 108 actual generated-caller scenarios, including two different
effect payloads, with 15 semantic faults and replays of all 18 executables.
The strict audit has 17 report refusals, including missing workspace permissions,
descriptor stores, metadata and concrete witness assignments. Allocated grow/
shrink witnesses fix inputs at 192/32 bytes and specialize those assignments
before solving; all remaining equations are retained. A separate test checks
equivalence under the fixed inputs and rejects conflicting assignments. The
auditor independently derives each complete assignment inventory from the
fresh fixture and canonical wire profile.

`npm run test:cpi-physical` also exercises missing interpreter, empty zero-exit,
nonzero and signaled child failures, retires success, preserves previous receipt
bytes and performs an actual fresh restoration. Component receipt bytes are
copied into each qualification run so later component runs cannot overwrite
its evidence reference. The focused receipt is
`build/cpi-physical/focused.json`; each receipt qualifies only its recorded
source/artifact hashes. The corrected focused replay and terminal audit passed;
`build/cpi-physical/focused-terminal-audit.json` checks 798 unchanged source
bindings and both private component receipts. Broader regression and full55
qualification remain distinct and pending for the new snapshot.

The typed DAG fingerprint adds full acyclic datatype declaration identity and
recognizer/accessor parameters. Cache sessions retain ASTs and reject cross-
context reuse; equal fingerprints still require exact AST equality. Recursive
datatypes and unsupported syntax reject. These are syntax and driver controls,
not logical equivalence claims. Allocation/initial-byte mapping, stable keys,
effect-native-byte correspondence, truthful runtime metadata/mutation bounds,
the restricted interpreters and Z3 remain trusted. This gate neither rederives
the entire interpreter trace independently nor proves LLVM/SBF preservation,
unconditional physical allocation, SPL accounting or transaction rollback.


### Maintained post-copy aggregate — 2026-10-07 UTC

The final source-frozen maintained refresh ran `npm run test:cpi-physical`
followed by `npm run verify:all`. Both completed successfully, and the terminal
and immutable consumed-report audits passed for all 1,004 recorded inputs.
Evidence: `build/overnight/quotient-refresh-20261006/maintained55-library-refresh-9cba1585-0392-4970-9999-12550e2fb2aa/audit.json`; focused CPI independent replay:
`build/overnight/quotient-refresh-20261006/maintained55-library-refresh-9cba1585-0392-4970-9999-12550e2fb2aa/cpi-physical-terminal-audit.json`.

The focused gate covers initial/restored three-fixture qualifications, 374 raw
SMT queries and 108 native scenarios per qualification, eighteen independently
replayed native executables per qualification, seventeen report controls and
four actual child-process failure controls. The aggregate contains all 55
source, arithmetic, emitted-C and conditional SBF artifact commands in their
recorded order. The combined refresh includes the serialized token physical-memory composition
and caller-to-physical CPI connection described above. The solver preprocessing
changes preserve the recorded assertions and original limits; failed earlier
runs remain evidence rather than successes.

These results bind the promoted generic library output-copy implementation and
the maintained proof drivers. They retain the allocation, stable-memory,
workspace, truthful-runtime-metadata, helper grammar and trusted-tool premises
of each component. They do not establish universal SHA equivalence, unconditional
C memory safety, LLVM/SBF preservation, external transaction rollback or an
end-to-end verified compiler. The subsequent handoff/refinement documentation
edits are related by the exact documentation-only correspondence report; runtime,
compiler, SDK and test bytes did not change.
