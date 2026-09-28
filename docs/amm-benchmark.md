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

| Transaction | Prior Bend CU | Current Bend CU | Rust CU | Current Bend / Rust |
| --- | ---: | ---: | ---: | ---: |
| Initialize | 83,277 | 83,277 | 36,082 | 2.31× |
| Deposit | 72,397 | 69,551 | 28,512 | 2.44× |
| Swap base for quote | 64,221 | 61,375 | 22,684 | 2.71× |
| Swap quote for base | 64,210 | 61,364 | 22,684 | 2.71× |
| Withdraw | 72,687 | 69,841 | 28,548 | 2.45× |
| Reject slippage | 35,318 | 32,472 | 6,958 | 4.67× |
| Reject zero input | 28,531 | 28,531 | 6,509 | 4.38× |
| Reject locked-share withdrawal | 28,438 | 28,438 | 6,414 | 4.43× |

The guarded wide-division route saves 2,846 CU in each fixture that executes
two wide divisions. The prior report is preserved locally at
`build/amm-benchmark-before-division-20260928.json`; the current report is
`build/amm-benchmark.json`. The Bend ELF grew from 63,480 to 63,904 bytes;
the Rust ELF remains 43,304 bytes. These are complete program measurements,
including decoding, validation, custody derivation,
arithmetic, token CPIs, state serialization and return data. They show useful
execution with a material compute overhead; they do not establish worst-case
costs or performance for other programs or input distributions.

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
reach only the baseline, parsed/PDA, decoded/clock, and transition markers.
The successful cases reach effect validation, token execution, and state write.

These intervals include logging syscall overhead and code changes caused by
instrumentation. They are observed costs of diagnostic binaries, not corrected
intrinsic phase costs. The parsed/PDA boundary also follows basic state account
checks. Bend constructs a context before the decoded/clock boundary; Rust has no
equivalent object. Before validation, Bend encodes state and extracts effects,
while Rust encodes its state payload. The state-write marker is before return
data publication. The phase diagnostic's swap follows initialization directly,
whereas the release benchmark's swap follows a deposit, so compare each report
within its own fixture sequence.
