# AMM acceptance audit

Status: **passed on 2026-09-20**. This is a
project self-review against [the milestone contract](amm-plan.md), not an
independent security audit or approval for production funds.

The global-invariant proof extension below was checked separately on
2026-09-21. It refreshes the AMM source-refinement result only; it is not a rerun
of the complete regression suite or benchmark recorded in the original audit.

## Requirement and evidence map

| Requirement | Implementation and evidence | Current assessment |
| --- | --- | --- |
| Entire pool lifecycle in Bend | `examples/amm/amm.bend`, public `PROOF.bend` build, TypeScript client; shared SBF tests for initialize/deposit/withdraw/both swaps and transferred LP shares | Full build and lifecycle checks pass |
| Shared SDK, no AMM compiler special cases | `sdk/issuance.bend`, `sdk/effects3.bend`, structural lowering in `compiler/effects.ts`; independent three-effect and issuance tests | Implemented, reviewed and regression-tested |
| Full-width arithmetic and guards | 588 pricing and 111 square-root oracle cases, Bend/reference/native/SBF and independent Rust checks; wide product/division prerequisites | Fresh full reference/native/SBF run passes |
| Checked-source arithmetic proofs | 69 square-root and 11 pricing obligations, source closure bindings, prerequisite proofs, helper contracts, mutations and concrete Bend witnesses | Fresh eleven-command suite passes |
| Accounting and authorization | 27 transition/accounting obligations; complete outcomes/effects, configuration, signature and locked-share checks; eight mutations | Fresh eleven-command suite passes |
| Swap invariant | Integer fee/floor lemmas plus exact checked-source reserve updates: `(x+gross)*(y-output) >= x*y` | Proved at source/model boundary |
| Adversarial behavior | Ten shared AMM SBF tests include 33 malformed-account/encoding/issuance cases, nine unsafe-initialization cases, limits, aliases, overflow, multiple holders, late CPI and multi-instruction rollback | Passes on Bend and Rust |
| Independent equivalent Rust SBF | `benchmarks/amm-rust/{main,wire,transition,pricing}.rs`; same ABI, validation, arithmetic, CPI order and failure semantics; no generated Bend code | Compiles and passes shared conformance |
| Fair complete-program measurements | Fixed test keys, same program ID/PDA/accounts/instructions, state/return/error comparisons, repeated identical measurements, binary and source hashes | `benchmark:amm` passes |
| Clear external workflow | Application/account/client guide, arithmetic guide, source-proof trust limits, benchmark procedure and results | Documented; links reviewed |
| Complete regression, reproducibility, audit | `npm test`, `npm run verify:all`, `npm run benchmark:amm`, evidence consistency check | 55 tests pass; all 11 refinement commands pass; benchmark and evidence audit pass |

## Recorded acceptance results

The complete regression run finished successfully, including 588 AMM pricing
and 111 square-root comparisons through the Bend interpreter, sanitized native
code, SBF and independent Rust arithmetic. Its final test target passed all 55
tests; the one ignored test is the benchmark, which was explicitly run twice by
`benchmark:amm`. Both benchmark runs produced identical results, and all ten
shared AMM integration tests passed against each implementation.

All eleven source-refinement commands pass. The evidence checker validates
report/source hashes, build manifests, ELF hashes, exact benchmark repetition,
and the completed suite logs. `build/amm-acceptance.json` records the current
source and evidence hashes. No required milestone item remains open within the
experimental scope defined above.

## Global-invariant proof extension (2026-09-21)

After the original audit snapshot, `npm run verify:amm` was rerun with explicit
global reserve-balance and LP-supply invariants. All 32 obligations passed; ten
mutated source variants produced SAT counterexamples with concrete Bend
witnesses, and the import-binding/schema negatives still failed closed. The
extension proves backing for aggregate current pro-rata claims, conditional on
successful exact SPL effects and atomic execution. It does not make dust-sized
withdrawals with a zero rounded leg redeemable, and it does not replace a full
runtime/benchmark audit rerun.

## Source review

The token effect lowerer validates record shape, field types, variant names,
amount/key layouts and recipient/authority enums before emitting extraction.
Three slots are selected from the structural effect type; ordinary two-slot
programs retain their interface. Mint, burn and bound transfers are generic SDK
effects. Pool rules, constants, prices and square root remain ordinary Bend.

Both single-state and multi-state adapters decode canonical data, obtain the
context, evaluate the transition, encode its result, validate **every** effect,
then execute them and commit state. Original SPL Token is the only permitted
token program. Custody derives from the program and state address. Transfer
bindings prevent substituted reserves; fresh reserves have zero balance, no
delegate/close authority and the custody owner. LP issuance requires the exact
mint, custody mint authority and no freeze authority, plus zero initial supply.
Burns require the actor signature and ownership. Actual balances, frozen state,
mint/burn arithmetic and transaction rollback remain SPL/runtime responsibilities.

The independent Rust adapter was compared against these checks, including error
precedence and canonical encoding. Its raw loader parser trusts the same loader
buffer bounds as the C adapter; it checks application/account contents. Rust
uses native u128 arithmetic and a Newton square root. Its successful SBF tests
also exercise its CPI ABI and stack behavior. Both binaries target SBF v0.

The refinement exporter evaluates checked definitions, and imported function
and type closures must match before summaries are used. Initialization guard
partitions are checked for coverage; the schema audit rejects uncovered
constructors. Quote summaries preserve both success and error results, with
congruence for identical arguments. All solver obligations require UNSAT;
UNKNOWN is failure. Mutated application definitions must produce SAT and an
independent concrete Bend discrepancy. These checks do not prove the exporter,
solver, compiler, LLVM or external runtime correct.

## Reproduce and check evidence

From the repository root with [the prerequisites](../README.md#build-and-test):

```sh
npm test > build/amm-final-test-suite.log 2>&1
npm run verify:all > build/amm-final-refinement-suite.log 2>&1
npm run benchmark:amm > build/amm-benchmark-check.log 2>&1
npx --no-install bun scripts/audit-amm.ts
```

Create `build/` first on a clean checkout (`mkdir -p build`). The evidence checker
rejects missing/stale reports, unexpected counts, changed source/ELF hashes or
unfinished full suites. It records the current source and evidence hashes in
`build/amm-acceptance.json`. The ignored benchmark test is explicitly executed by
`benchmark:amm`; it is not silently counted as part of `npm test`.

The [benchmark guide](amm-benchmark.md) reports observed costs, not worst-case
bounds. Local testing requires no wallet or public deployment. Token-2022,
wrapped SOL, delegated spending, dynamic collections, general runtime recursion
and production deployment are outside this milestone's contract.
