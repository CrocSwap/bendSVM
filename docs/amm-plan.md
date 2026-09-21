# Constant-product AMM milestone

Status: **complete for the local experimental milestone**. The
[AMM acceptance audit](amm-acceptance-audit.md) records the completed evidence;
the previous three-application audit is a separate milestone.

## Objective

Build a constant-product AMM entirely in Bend using the shared SDK, prove its
core arithmetic and accounting properties, and benchmark its SBF execution
against an equivalent Rust implementation. Keep the implementation, examples,
and instructions clear enough for an external developer to reproduce the work.

The application rules and arithmetic belong in ordinary Bend. Necessary token
operations belong in the shared SDK and runtime, with independent tests. Do not
add AMM-specific compiler branches or replace Bend arithmetic with native helpers.

## Protocol specification

Use two distinct original SPL Token mints, PDA-controlled reserve accounts, and a
transferable SPL Token LP mint controlled by the same PDA. Bind the reserve
account addresses and all three mint addresses in immutable pool configuration.
The LP mint must start with zero supply, the pool as sole mint authority, and no
freeze authority. Reserve accounts must start empty, with custody ownership and
no delegate or close authority. Validation must prevent reusing a live LP mint
or substituting a different custody account with the same mint.

Support initialization with atomic two-token funding, subsequent liquidity
deposits, proportional withdrawals, and exact-input swaps in both directions.
Every user operation requires the actor signature. Users specify minimum output
for swaps, maximum token payments for deposits, and minimum token receipts for
withdrawals. Transaction submission and expiry are client responsibilities;
there is no price oracle or governance authority in this example.

Arithmetic uses u64 token amounts and full u128 intermediate products:

- Initialization: total LP accounting supply is `floor(sqrt(x*y))`. Permanently
  reserve 1,000 accounting shares and mint the remainder to the initializer.
  Reject initial liquidity that cannot leave positive user shares. The locked
  shares are never minted: SPL supply plus 1,000 equals accounting supply during
  ordinary operations. Voluntary out-of-band LP burns may make SPL supply smaller;
  they cannot increase redemption rights.
- Deposit: the user requests a positive number `s` of LP shares. Required amounts
  are `ceil(x*s/L)` and `ceil(y*s/L)`, bounded by the user's maxima. Check reserve
  and accounting-supply additions before either transfer, then mint `s` shares.
- Withdrawal: burn positive `s` user shares and pay `floor(x*s/L)` and
  `floor(y*s/L)`. Preserve the locked shares, reject zero token receipts, and
  enforce both user minima before any effect.
- Swap: charge `fee = ceil(gross_input*30/10_000)` (30 basis points), use
  `effective = gross_input-fee`, and pay
  `floor(output_reserve*effective/(input_reserve+effective))`. Reject zero input,
  zero effective input, zero output, and reserve overflow. Credit the full gross
  input to reserves: fees stay in the pool and accrue to LPs. This rounded-up fee
  convention intentionally affects tiny trades and must match the Rust baseline.

All rounding favors existing liquidity. Unsolicited token transfers are surplus,
not newly issued shares or accounted reserves. No administrative surplus sweep is
part of this example. Operations must remain solvent relative to recorded
reserves; token-program failures roll back every earlier effect and state update.
Token-2022, transfer fees, wrapped SOL and delegated spending are outside scope.

## Required deliverables and evidence

| Requirement | Evidence needed for completion |
| --- | --- |
| Bend pool lifecycle | Public build, real SPL Token initialize/deposit/withdraw/bidirectional swap tests, multiple LP holders |
| Shared SDK additions | General mint/burn and three-effect support with structural rejection tests, authority/recipient tests, and rollback tests independent of AMM |
| Core arithmetic | Checked-source refinement of quotes, full-precision floor/ceiling, square root bounds, overflow rejection, and nonzero/limit guards |
| Pool accounting | Checked-source transition proofs of reserve/share changes, fixed configuration, authorization and exact effect construction |
| Swap invariant | For each accepted swap, integer proof that `(x+gross)*(y-output) >= x*y`, including fee and rounding assumptions |
| Adversarial behavior | Wrong accounts/mints/authorities, repeated initialization, insufficient funds/shares, malformed encoding, slippage, boundary amounts, and late-CPI rollback |
| Rust baseline | Independently implemented Rust SBF program with equivalent wire/account validation, token effects, arithmetic semantics and failure behavior; no generated Bend C in baseline |
| Fair measurements | Same runtime/toolchain target, account fixtures and inputs; per-operation CU and ELF sizes; successes and representative rejections; tool versions, hashes and repeatable command |
| External-user workflow | Commented example, account/instruction reference, client walkthrough, clean build/test/proof/benchmark commands, expected results and trust limits |
| Final audit | Requirement-by-requirement current evidence, full existing regression suite, reproducible builds, and review of runtime/compiler changes |

Source proofs do not establish compiler, LLVM, runtime or SPL Token correctness.
Keep symbolic proof results, differential tests, SBF execution and benchmarks
separate in reports. Any review performed here is a project self-review; an
independent security audit is a separate release gate and must not be implied.

## Work sequence

1. Implement and differentially test pure pricing and liquidity arithmetic.
2. Extend the shared token SDK for LP issuance/redemption and three atomic effects.
3. Implement the Bend transition and client with full lifecycle/adversarial tests.
4. Bind arithmetic and transition proofs to the checked source; use negative
   mutations to establish that the proof harness detects incorrect behavior.
5. Build the equivalent Rust program and run shared conformance fixtures and
   benchmarks; report observed costs without claiming worst-case bounds.
6. Finish the external-user guide and conduct the final acceptance audit.

Keep this scope intact when a test exposes missing SDK functionality. A
single-provider pool, nontransferable LP receipts, quote-only microbenchmark, or
integer model disconnected from the checked Bend source does not satisfy it.

## Current evidence

- The complete Bend pool lifecycle and TypeScript client are implemented.
  Application logic, full-width arithmetic and square root remain ordinary Bend;
  shared issuance/binding/three-effect support contains no AMM-specific branches.
- Ten shared AMM SBF tests pass against both Bend and the independent Rust SBF
  program. They cover multiple holders, transferred shares, both swap directions,
  full-width amounts, donations/external burns, rollback, 33 malformed-input and
  issuance cases, and nine unsafe-initialization cases.
- Arithmetic conformance uses 588 pricing and 111 square-root cases across an
  independent oracle, Bend evaluation, sanitized native code, SBF and Rust.
- Source refinements include 69 square-root, 11 pricing and 27 complete
  transition/accounting obligations, plus proved helper contracts and imported
  arithmetic prerequisites. Mutation tests require counterexamples and concrete
  Bend witnesses; source binding and schema negatives fail closed.
- `npm run benchmark:amm` builds both programs reproducibly, runs shared
  conformance, compares identical fixed fixtures and repeats the measurements
  exactly. Successful Bend operations consume about 2.31–2.83 times the Rust
  baseline's CU. ELF sizes are 63,480 bytes for Bend and 43,304 bytes for Rust.
  [The benchmark guide](amm-benchmark.md) explains inputs, results and limits.
- `npm run test:token-sdk` separately exercises generic issuance, transferable
  receipts, exact bindings, fresh custody, three-effect execution and atomic
  one-/two-state rollback.

The full `npm test` run passes all 55 tests, and the eleven-command
`npm run verify:all` suite passes. The final evidence consistency check passes.
The [AMM acceptance audit](amm-acceptance-audit.md) maps every requirement above
to its source, tests, proof reports and completed validation. The previous
[three-application audit](acceptance-audit.md) does not establish this milestone.

## External developer entry points

- [Application and client guide](amm.md): account preparation, operations,
  rounding, errors, build and lifecycle commands.
- [Example guide](../examples/amm/README.md): source tour and arithmetic checks.
- [Refinement guide](refinement.md): source bindings, obligations, negative tests
  and the boundary between source proofs and SBF testing.
- [Benchmark guide](amm-benchmark.md): independent baseline, reproducible command,
  observed costs and comparability limits.
