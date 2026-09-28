# Arithmetic and application refinement checks

Run every supported refinement command with `npm run verify:all`. It fails on
any failed command and records hashes of the seventeen reports in
`build/refinement-suite.json`. These checks remain separate from `npm test` and
from production program builds. See the [three-application audit](acceptance-audit.md)
and [AMM audit](amm-acceptance-audit.md) for historical integrated milestone
evidence. The [container milestone review](containers-acceptance-audit.md) records
the accepted generic-container and bounded-iteration expansion.

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
the exercised cases, not a compiler preservation proof.

Application transition invariants, multiplication and wide division/rounding
are covered by the separate commands below. Ordinary `npm test` retains its
existing prerequisites; the solver command must be run explicitly for refinement
claims. A program build does not imply that this command was run on its source.

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
steps cannot subtract a divisor with a nonzero high limb, and that the
`(low limb shifted into quotient, high limb as remainder)` state correctly
starts the remaining 32 steps. Only after these checks pass may the wrapper
evaluator use the established division result as a summary for `div32` and
`div64`. It verifies the checked public `divmod`, `div` and `mod` definitions:
zero divisor returns error 3; a smaller dividend or divisor one returns its
direct exact result; a high-limb divisor takes the guarded 32-step path; all
other nonzero cases take the 64-step path. It checks source guards, initial
states, returned fields and path coverage. The final integer identity and
remainder bound characterize the unsigned Euclidean quotient/remainder.

Four wrapper source mutations swap the returned quotient/remainder, change the
zero-divisor error, corrupt the smaller-dividend exit, and corrupt the
high-divisor initial quotient state. They leave the step/induction intact but
fail wrapper checks; their solver inputs are replayed in Bend against BigInt
division/remainder.

All step, induction, fast-path and wrapper obligations return UNSAT. Six
semantic mutations produce replayed counterexamples and the missing-step
mutation is rejected.
The older `verify:division-step` command remains an alias for the complete check.

This is a compositional verification argument: the solver obligations, induction
driver, connection to the checked composition and wrapper summaries remain part
of the trusted verifier. It is not a Bend-checked proof term or verification of
C/LLVM/SBF lowering. The complete wide multiply/divide API remains outside these division claims, even though the loop induction also permits a
valid nonzero initial high-limb remainder.


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

Before using summaries, it reruns all fourteen multiplication obligations on
the exported models and proves the wide module's actual imported restoring
step, composition tree and 68 induction obligations. This binds the argument to
the implementation used by the wide API, including its nonzero initial remainder.
It then establishes six additional obligations:

- For `N = high*2^64 + low` and a positive u64 divisor `d`, the quotient overflows
  u64 exactly when `high >= d`.
- Euclidean quotient/remainder characterize floor and ceiling:
  `floor(N/d) = q`, `ceil(N/d) = q + (r != 0)`.
- The checked `divide` wrapper returns error 3 for zero divisor, error 1 for
  quotient overflow, and otherwise calls the proved loop exactly once with
  `(low, high, d)` and returns its correct quotient/remainder fields.
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

Seven source mutations discard the high dividend, reverse the overflow guard,
change the zero-divisor error, swap multiplier/divisor inputs, return the
remainder instead of the floor, reverse the exact-rounding guard and discard the
ceiling increment. Each must produce SAT for its targeted obligation while the
product/loop prerequisites still pass. Each also has an independent concrete
Bend/BigInt witness; these are not presented as replays of abstract SMT inputs.
Unknown/timeouts are rejected for all positive and negative obligations.

`build/wide-refinement.{math.model.json,model.json,json}` contains the checked
models and the report, including all prerequisite results, six API obligations,
seven mutation witnesses and source/verifier hashes. These claims cover the
shared arithmetic, not the vesting/exchange economic invariants or compiled
C/LLVM/SBF behavior.

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
69 obligations: the trial-bit step, initialization/extraction and geometric-mean
wrappers, the initial interval, 64 interval-preservation steps, and the final
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
root. The source wrapper starts with `r=0,b=2^63` for every u128 target.

The bitvector product is abstracted only after its implementation is proved.
Connecting that product interpretation and the checked composition tree to the
integer induction is part of the trusted proof driver, as with division.
This is a source theorem, not a proof of emitted C, LLVM or SBF behavior.

Five well-typed semantic mutations produce SAT results and concrete Bend
counterexamples: reversed comparison, discarded accepted bit, non-advancing bit,
wrong candidate, and missing initial top bit. A skipped half-loop fails the
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
