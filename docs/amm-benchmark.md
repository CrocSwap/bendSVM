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

| Transaction | Before this pass Bend CU | Current Bend CU | Rust CU | Current Bend / Rust |
| --- | ---: | ---: | ---: | ---: |
| Initialize | 60,916 | 49,246 | 36,082 | 1.36× |
| Deposit | 47,266 | 36,156 | 28,512 | 1.27× |
| Swap base for quote | 39,374 | 29,949 | 22,684 | 1.32× |
| Swap quote for base | 39,363 | 29,938 | 22,684 | 1.32× |
| Withdraw | 47,555 | 36,473 | 28,548 | 1.28× |
| Reject slippage | 11,403 | 9,973 | 6,958 | 1.43× |
| Reject zero input | 7,462 | 6,032 | 6,509 | 0.93× |
| Reject locked-share withdrawal | 7,369 | 5,939 | 6,414 | 0.93× |

The preceding pass located most of the earlier gap in duplicate-account key
comparisons and reduced these fixtures by 21,069–22,361 CU with a bytewise
early exit. This pass compares public keys in four alignment-safe 8-byte chunks,
stopping at the first unequal chunk, and clears each encoded ADT wire region
once before writing nested active fields. Together these changes save
1,430–11,670 CU per transaction against the preceding pass. The current report
is `build/amm-benchmark.json`; the Bend ELF is 62,568 bytes and the Rust ELF is
43,304 bytes. Earlier guarded wide-division work saved 2,846 CU in fixtures
that execute two wide divisions; its earlier report is preserved locally at
`build/amm-benchmark-before-division-20260928.json`. These are complete program measurements,
including decoding, validation, custody derivation,
arithmetic, token CPIs, state serialization and return data. They show useful
execution with a material compute overhead; they do not establish worst-case
costs or performance for other programs or input distributions. In particular,
the key comparison's cost depends on how many leading 8-byte chunks two public
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
The successful cases also reach state encoding, effect handling, validation,
token execution, and state write. Bend converts source effects to runtime
descriptors after the transition; Rust constructs its typed effects inside
the transition, so the report uses separate marker names and orders.

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

The diagnostic zero-input rejection spent 22,744 CU from baseline to accounts
parsed in Bend before bytewise early exit, 1,797 CU after that change, and
1,220 CU with chunk comparisons. Rust currently spends 1,353 CU in that
interval. Its checkpoint moved just before the Token Program check in the
second diagnostic version to match the Bend boundary more closely. The
diagnostic's successful swap now spends 30,958 CU in Bend versus 23,703 CU in
Rust. Bend spends 1,557 CU from transition to state encoded, 363 CU on effect
conversion, and 596 CU on effect validation; Rust spends
147 CU on result mapping, 239 CU on payload encoding, and 757 CU on effect
validation. The Bend/Rust decoded/clock-to-transition gap is 3,650 CU. These
figures include marker overhead and apply only to the recorded fixtures and
diagnostic binaries. Rust's effect construction is included before its
transition marker, so the 363 CU conversion interval has no matching Rust
post-transition step.
