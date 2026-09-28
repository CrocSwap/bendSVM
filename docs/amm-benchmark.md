# Bend and Rust AMM comparison

Run from the repository root after installing the [prerequisites](../README.md#build-and-test):

```sh
npm run benchmark:amm
```

The command builds the public Bend AMM and an independent Rust SBF program,
checks reproducible binaries, runs the same ten AMM integration tests against
each implementation, and repeats a fixed-fixture comparison twice. It requires
no wallet, RPC, or deployment. The report is `build/amm-benchmark.json` and
includes source/ELF hashes, toolchain versions, build manifests, and the results
of both conformance and repeatability checks.

## Observed results

These measurements use LiteSVM 0.7.1, Anza platform-tools v1.53 / LLVM 20.1.7,
and SBF v0 with the generic CPU and optimization level 2 for both programs.
The Rust toolchain's installed target is named `sbpf-solana-solana`; the build
checks that its ELF flags select SBF v0. Rust uses its native u128 arithmetic;
Bend uses the ordinary limb-based SDK definitions compiled through C.

| Transaction | Before key change Bend CU | Current Bend CU | Rust CU | Current Bend / Rust |
| --- | ---: | ---: | ---: | ---: |
| Initialize | 83,277 | 60,916 | 36,082 | 1.69× |
| Deposit | 69,551 | 47,266 | 28,512 | 1.66× |
| Swap base for quote | 61,375 | 39,374 | 22,684 | 1.74× |
| Swap quote for base | 61,364 | 39,363 | 22,684 | 1.74× |
| Withdraw | 69,841 | 47,555 | 28,548 | 1.67× |
| Reject slippage | 32,472 | 11,403 | 6,958 | 1.64× |
| Reject zero input | 28,531 | 7,462 | 6,509 | 1.15× |
| Reject locked-share withdrawal | 28,438 | 7,369 | 6,414 | 1.15× |

The diagnostic below located most of the previous gap in the duplicate-account
key comparisons. Account keys are public, so `equal_key` now returns on the
first unequal byte while still checking all 32 bytes for equal keys. The matched
benchmark fell by 21,069–22,361 CU per transaction. The current report is
`build/amm-benchmark.json`; the Bend ELF is 62,896 bytes and the Rust ELF is
43,304 bytes. Earlier guarded wide-division work saved 2,846 CU in fixtures
that execute two wide divisions; its earlier report is preserved locally at
`build/amm-benchmark-before-division-20260928.json`. These are complete program measurements,
including decoding, validation, custody derivation,
arithmetic, token CPIs, state serialization and return data. They show useful
execution with a material compute overhead; they do not establish worst-case
costs or performance for other programs or input distributions. In particular,
the early-exit comparison's cost depends on how many leading bytes two public
keys share.

The report also checks each LiteSVM invocation log against the transaction CU
total and expected Token Program call count. Token Program child invocations use
the same inclusive CU under Bend and Rust: 16,899 for the three calls in
initialization or deposit, 12,400 for the two calls in either swap, and 17,108
for the three calls in withdrawal. Rejected fixtures make no Token Program call.
Child CU is already included in the root total. The observed Bend/Rust gap is
therefore outside the Token Program's execution; the report does not separate
caller-side CPI setup from validation, arithmetic or serialization.

## How the comparison stays matched

The fixtures use fixed public test seeds and the same program address, state
address, PDA, account balances, instruction bytes and metadata. This also keeps
PDA bump-search work identical. The harness compares relevant account contents
before and after every transaction, plus return data and rejection codes.
Rejected transactions must leave application and token state unchanged.

Initialization starts with 100,000 base and 400,000 quote and mints 199,000 LP
tokens (1,000 shares remain locked). The sequence deposits 10,000 shares, swaps
1,000 units in each direction, withdraws 10,000 shares, then exercises three
rejections. State allocation happens outside the measured initialization call.
The test seeds are public fixtures, not usable wallet credentials.

The Rust baseline implements the same fixed wire layout, account checks,
custody rules, effect order, arithmetic rounding and error precedence. Its
[source](../benchmarks/amm-rust/main.rs) links no generated Bend implementation.
The shared integration tests additionally cover 33 malformed account/encoding
and issuance cases, nine unsafe-initialization cases, plus multiple LP holders, transferred
shares, donations, external burns, overflow, and late-CPI rollback.

The benchmark proves agreement on these fixtures, not universal backend or
runtime equivalence. [Source refinements](refinement.md) establish separate
properties of checked Bend terms. The [acceptance audit](amm-acceptance-audit.md) records the completed full
regression and source review.

## Separate phase diagnostic

`npm run benchmark:amm:phases` builds the checked Bend AMM into
`build/amm-phases/checked`, instruments a copy of its generated C, and compiles
a copy of the independent Rust sources with the same pinned SBF tools. It does
not change the release programs or `build/amm-benchmark.json`. Its focused,
ignored LiteSVM test compares fixed public keys, identical instruction bytes,
account snapshots, return data, rejection codes, and rollback for initialization,
zero-input rejection, slippage rejection, and a successful base-to-quote swap.
The command runs the test twice and requires byte-identical phase reports.

The diagnostic report is `build/amm-phases/report.json`. Each stage has its raw
remaining-CU log reading; adjacent readings yield interval deltas. Root total
CU and nested Token Program CU are recorded separately. The child CU is already
included in the root and in the interval spanning token execution. Rejections
reach only the baseline, accounts parsed, parsed/PDA, decoded/clock, and transition markers.
The successful cases reach effect validation, token execution, and state write.

These intervals include logging syscall overhead and code changes caused by
instrumentation. They are observed costs of diagnostic binaries, not corrected
intrinsic phase costs. The accounts parsed boundary follows initial instruction
checks; the parsed/PDA boundary also follows the Token Program and basic state account
checks. Bend constructs a context before the decoded/clock boundary; Rust has no
equivalent object. Before validation, Bend encodes state and extracts effects,
while Rust encodes its state payload. The state-write marker is before return
data publication. The phase diagnostic's swap follows initialization directly,
whereas the release benchmark's swap follows a deposit, so compare each report
within its own fixture sequence.

Before the key comparison change, the diagnostic zero-input rejection spent
22,744 CU from baseline to accounts parsed in Bend. With the change, that
interval is 1,797 CU in Bend and 1,353 CU in Rust. The Rust checkpoint also
moved just before its Token Program check to match the Bend boundary more
closely. The diagnostic's successful swap now spends 40,178 CU in Bend versus 23,501 CU in
Rust. Its largest remaining interval gaps are 10,300 CU from transition to
validated (including state encoding and effect extraction) and 3,650 CU from
decoded/clock to transition. These figures include marker overhead and apply
only to the recorded fixtures and diagnostic binaries.
