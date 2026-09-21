# Shared Bend/SBF application milestone

Goal: a broad, documented Bend subset sufficient for a vault, vesting contract
and small exchange, all using the same compiler and SDK without application-
specific compiler changes. The original escrow POC is the baseline, not completion.

## Completion requirements

- Shared compiler: typed, specified arithmetic; enough control flow and data
  representation for all three applications; explicit unsupported-feature errors.
- Shared Bend SDK and generated interfaces: instruction dispatch, account storage,
  authorization, clock access, token custody and CPI. Application business rules
  reside in Bend. Application manifests describe interfaces, not alternative C
  implementations. Compiler and SDK contain no switches on application names.
- Vault: initialize, deposit and withdraw actual test tokens with authority,
  mint/account validation, checked accounting and rejection of unauthorized or
  excessive withdrawals.
- Vesting: create/fund a schedule, claim according to runtime time, partial/repeat
  claims and completion, without releasing more than funded entitlement.
- Small exchange: create/fund a fixed-price offer, partial fills with explicit
  integer price/rounding rules, cancellation, slippage and atomic settlement of
  both token legs. A fixed-price exchange is the chosen small-exchange model;
  an AMM/orderbook is not required for this milestone.
- Meaningful laws and negative proof tests; clearly distinguish proved source
  properties, tested compiler/adapter behavior, and remaining trust assumptions.
- SBF transaction tests for each application, including initialization, actual
  token movements, malformed inputs, authority/owner/mint/alias failures,
  arithmetic boundaries and failed-CPI rollback. Exercise composability across
  the common interface. Differential tests for new compiler operations.
- Reproducible build/test commands, per-application size/CU measurements,
  SDK/subset/interface documentation and examples usable without custom C.

## Completed work sequence

The [final acceptance audit](acceptance-audit.md) maps every completion requirement
above to current source, commands and test evidence. All five workstreams pass:

1. **Arithmetic foundation:** checked u64 and full-precision multiply/divide,
   explicit error/rounding semantics, independent differential tests and
   compositional source refinement.
2. **Compiler and interfaces:** shared checked-term lowering, canonical generated
   codecs/clients, documented runtime subset and strict unsupported/proof gates.
3. **Shared Solana SDK:** authorization/clock/storage, original SPL Token custody,
   two-to-four-state layouts and bounded general CPI with rollback and resize tests.
4. **Vault, vesting and exchange:** complete real-token lifecycles, Bend laws,
   source-transition refinement, adversarial validation and cross-program composition.
5. **Integrated acceptance:** full `npm test` (33 SBF tests), all eight refinement
   commands, formatting, final measurements, fresh-workspace byte-for-byte
   reproduction and documentation audit.

The goal is complete for the documented subset, not for full Bend compatibility
or production/end-to-end formal assurance. The chronological entries below are
historical checkpoints; their open items were resolved by later work and the
final audit, rather than removed from the requirements.

No public-network deployment or messages to third parties are necessary.
The runtime and toolchain remain pinned while this milestone is developed.

## Historical checkpoints (2026-09-20)

`npm test` passed all existing escrow tests, the independent selection fixture,
11 existing negative checks, six SDK laws/three proof mutations, and 2,928 new
arithmetic reference/native/SBF comparisons. `cargo fmt --all -- --check` passes.
`compiler/` contains no application-specific names or branches. Arithmetic is
implemented in `sdk/math.bend`; `compiler/primitives.ts` only lowers pinned Base
operations. The arithmetic wire dispatcher is test-only, not the application SDK.

The latest `npm test` also passes generated interfaces and shared storage; see
[interfaces.md](interfaces.md) for format, tests and limitations. The pure
interface fixture passed 288 SBF cases (maximum 184 CU); the storage fixture's
initialization/update lifecycle passed at maximum 2,447 CU including System
Program creation. These are fixture costs, not application benchmarks.

The subsequent checkpoint passes the full `npm test` suite with 12 SBF tests,
including the vault and actual rollback after a second-leg CPI failure. The
vault ELF is 16,840 bytes; the latest measured lifecycle maximum was 24,706 CU
(PDA derivation varies by address). See [vault.md](vault.md). Larger aggregate
support now includes Solana memory syscall wrappers and a fail-closed import
allowlist; native value size is capped at 1,024 bytes and SBF stack frames are
checked by Clang.

Next implementation work: remaining mathematical refinements, remaining SDK
capabilities and full acceptance audit. The goal is not complete.

The vesting checkpoint passes the full `npm test` suite with 17 SBF tests and
480 additional wide-arithmetic/entitlement oracle vectors through BigInt, Bend,
native sanitizers and SBF. The vesting ELF is 28,816 bytes and the latest sample
lifecycle maximum was 30,934 CU; wide and entitlement probes measured 3,856 and
3,868 CU respectively. Source-level vesting laws and four mutations pass.
`tests/token_fixture.rs` now shares real System/Token setup between application
tests. Vesting required no compiler/runtime special cases. These results do not
close the outstanding universal arithmetic proofs or final acceptance audit.

The exchange checkpoint passes the full `npm test` suite with 23 SBF tests.
Exchange pricing adds 72 BigInt/reference/native/SBF vectors. The exchange ELF
is 30,688 bytes and the latest sample lifecycle maximum was 49,277 CU. Tests
compose all three programs and verify cross-program rollback. The public
`build:program` command reproduces all test ELFs, interfaces and source/artifact
manifests in fresh output directories. A separate workspace with a fresh npm
install and pinned Bend checkout also reproduced all artifacts/manifests using
the same local Anza toolchain. See [acceptance-audit.md](acceptance-audit.md) for
the requirement-level checkpoint and remaining work; completion is not claimed.

The validation/refinement checkpoint adds 323 adversarial transactions: 91 each
for vault/vesting and 141 for exchange, with every passed/canonical account
unchanged on failure and successful valid operations afterward. All 26 SBF tests
pass. `npm run verify:arithmetic` reports UNSAT for universal checked-u64 add,
subtraction, less-than and equality relative to modeled U32 semantics. Three
incorrect implementations yield SAT counterexamples that replay in Bend evaluation.
See [validation.md](validation.md) and [refinement.md](refinement.md) for exact
coverage, prerequisites and trust boundaries. The normal source/bytecode path
is unchanged; all three public builds still reproduce their test binaries.

The next refinement checkpoint proves the checked `Math.div_step` for all valid
64-bit `(q,r,d)` states (`d > 0`, `r < d`) against an exact 65-bit remainder
intermediate and verifies remainder bounds/divisor preservation. Checked-term
composition inspection establishes exactly 64 steps. Carry/quotient mutations
produce counterexamples replayed in Bend, and a missing-step mutation is rejected.
`npm run verify:division-step` and the existing arithmetic refinement command
pass. This closes the local-step obligation, not the overall div/mod induction,
wrapper correctness or wide multiplication/division obligations.

The division checkpoint now connects the proved step to 68 induction obligations
and checked public div/mod wrappers. All obligations pass. Two added wrapper
mutations (swapped quotient/remainder and wrong zero-divisor error) yield solver
counterexamples replayed in Bend; carry/shift mutations and missing-step rejection
continue to pass. `npm run verify:division` runs the complete compositional check.
Multiplication, wide API refinement and the remaining SDK/final-audit work stay open.


The multiplication checkpoint adds `npm run verify:multiplication`: fourteen
positive obligations establish partial-product assembly, exact limb routing,
integer expansion/bounds and checked overflow for u64 multiplication and exact
128-bit products. All pass. Four helper mutation counterexamples replay through
Bend; three routing mutations fail and have separate concrete Bend witnesses.
Wide division/rounding, broader SDK capabilities and final acceptance remain open.


The wide-arithmetic checkpoint adds `npm run verify:wide`. It reruns product and
imported-loop prerequisites, then checks six overflow, integer-rounding and
checked-wrapper obligations. Seven well-typed source mutations must fail their
targeted obligations and disagree with BigInt on independent concrete Bend
inputs. This closes the shared arithmetic refinement work under the documented
SMT trust boundary. Broader SDK capabilities, stronger application economic
invariants and the final acceptance audit remain open.

The vesting-accounting checkpoint adds `npm run verify:vesting`: four obligations
cover exact initialization funding, exact payout/state/effect updates, error
propagation and non-wrapping conservation bounded by the funded total. Four
mutated sources yield counterexamples replayed in Bend. The verifier evaluates
the checked payout/funding code without arithmetic summaries. Connecting timed
entitlement and the full authorized entrypoint remains outstanding, alongside
exchange/vault economic invariants, broader SDK support and final acceptance.


The complete vesting source-transition checkpoint adds
`npm run verify:vesting-process`. It binds the imported floor dependency closure
to the arithmetic proof, reruns prerequisites, and checks entitlement routing/
bounds plus every state/instruction case. This connects signed beneficiary
claims to exact cumulative time-based payout accounting for initialized valid
schedules. Four source mutations have concrete full-entrypoint Bend witnesses;
a corrupted import is rejected. Adapter/CPI execution remains tested, not proved.
Vault/exchange economic invariants, broader SDK support and final acceptance
remain outstanding.

The complete vault source-transition checkpoint adds `npm run verify:vault`.
It evaluates the checked entrypoint without summaries, proving all six dispatch
cases and two exact integer conservation equations. Five defects in authorization,
effects, withdrawal arithmetic and initialization yield full-input counterexamples
replayed in Bend. Exchange economic invariants, broader SDK support and the final
acceptance audit remain outstanding; external token execution remains tested.

The complete exchange source-transition checkpoint adds `npm run verify:exchange`.
It binds/rechecks ceiling arithmetic, then checks nine dispatch cases, exact
settlement/refund/funding effects, inventory conservation and ceiling-price bounds.
Six source mutations have concrete full-entrypoint Bend witnesses, and a corrupted
import is rejected. Pricing/maximum-payment guarantees are per fill. All three
applications now have source-level economic transition refinement under the
explicit SMT/adapter trust boundary. Broader SDK capabilities and the final
requirement-by-requirement acceptance audit remain outstanding.

The multi-state adapter checkpoint adds explicit ABI-2 layout configuration to the
public builder, with two to four record fields mapped to separate state accounts,
per-field schema headers, aggregate return data and a client codec. A two-account
SBF fixture verifies simultaneous initialization/update and unchanged accounts on
signature/permission/owner/header/size/alias/application rejection. Fresh builds
reproduce. Existing single-account interfaces retain ABI 1. Discarded affine
parameters now compile cleanly under the existing Clang warning policy. Effectful
multi-state integration, larger state-count validation, arbitrary CPI and the
final acceptance audit remain outstanding.


The larger-layout checkpoint verifies the full two-to-four-state adapter range.
Distinct three/four-field record types exercise decoding, checked Bend rotation,
projection to accounts and aggregate return encoding. Every state slot, alias
pair and state-account swap is rejected appropriately on invalid input without
partial updates; 30/44 account-rejection cases pass, plus signature/count/application
checks. Fresh public builds and client codecs pass. Effectful multi-state
integration, arbitrary CPI and the final acceptance audit remain outstanding.


The effectful multi-state checkpoint covers all supported state counts with
real System Program account creation and original SPL Token CPIs. Second-leg
failure rolls back the successful first transfer and all state updates; failed
initialization also rolls back every allocation. Secondary-state validation,
primary-derived custody, successful recovery, aggregate replies and reproducible
builds pass. Arbitrary-program CPI and final integrated acceptance remain open.


The first arbitrary-CPI checkpoint adds `sdk/cpi.bend`, structural effect lowering
and a shared executor for two slots, 64-byte payloads and eight account metas per
call. Expected program/account keys, privileges, custody signatures and managed
state write protection are checked. An independent SBF callee tests actor/PDA
signatures and write-then-fail rollback. Native C values now allow 1,536 bytes,
with wire/frame limits unchanged. Two-call, multi-state and external-resize
integration remain pending before final SDK acceptance.


The two-call generic-CPI checkpoint covers single-state and all supported
multi-state counts. Successful first calls are rolled back on second-call failure;
invalid second effects reject before invoking either callee. External account
size changes propagate to the next call, and failed pairs roll back growth and
data as well as all managed state. Managed-state write rejection is checked by
exact error code. All fixtures reproduce via the public builder. The remaining
work is the final integrated acceptance audit against the complete milestone.
