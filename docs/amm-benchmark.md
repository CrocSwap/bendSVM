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
Bend uses ordinary limb-based wide arithmetic and guarded native lowering for
the exact checked SDK `Math.divmod` and `Math.mul32` definitions.

| Transaction | Prior Bend CU | Current Bend CU | Rust CU | Current Bend / Rust |
| --- | ---: | ---: | ---: | ---: |
| Initialize | 36,634 | 36,634 | 36,082 | 1.02× |
| Deposit | 34,136 | 31,134 | 28,512 | 1.09× |
| Swap base for quote | 27,930 | 24,926 | 22,684 | 1.10× |
| Swap quote for base | 27,919 | 24,927 | 22,684 | 1.10× |
| Withdraw | 34,454 | 31,401 | 28,548 | 1.10× |
| Reject slippage | 9,701 | 6,705 | 6,958 | 0.96× |
| Reject zero input | 6,032 | 6,032 | 6,509 | 0.93× |
| Reject locked-share withdrawal | 5,939 | 5,939 | 6,414 | 0.93× |

The public benchmark refreshed this table on 2026-10-03 after the generic
high-zero wide-division route was integrated. Both implementations passed eleven
non-ignored checks (shared integration tests and the invocation-log parser);
all eight matched benchmark rows repeated identically. Current source/artifact
hashes and invocation totals were audited in
`build/wide-native64-scout/main-benchmark-audit.json`; the report and binaries
are archived in `build/wide-native64-scout/main-benchmark-evidence/`.

The route calls the existing guarded native u64 division when the dividend's
high word is zero. It saves 2,992–3,053 CU on the priced successful fixtures and
2,996 CU on slippage refusal. The Rust ELF, Rust CU and child Token Program costs
are unchanged, and the current main ELF and measurements match the isolated
candidate. These are fixed-fixture results, not worst-case bounds. The earlier
refresh is preserved in `build/amm-refresh-20261003/audit.json`; its initialize
improvement from 41,039 to 36,634 CU preceded this isolated route change.

The earlier generic native-arithmetic pass saved 6,460 CU on initialize and
about 270 CU on the deposit, swap and withdrawal fixtures. These are whole
transaction differences, not isolated arithmetic instruction costs. The prior
pass replaced the adapter's byte loops at state commit with bounded copies
from already encoded local buffers, saving 1,747 CU on successful fixtures.
The current report is `build/amm-benchmark.json`; the Bend ELF is 66,472 bytes
and the Rust ELF is 43,304 bytes. The preceding key-comparison and codec
changes are described in the handoff. Earlier guarded wide-division work saved 2,846 CU in fixtures
that execute two wide divisions; its earlier report is preserved locally at
`build/amm-benchmark-before-division-20260928.json`. These are complete program measurements,
including decoding, validation, custody derivation,
arithmetic, token CPIs, state serialization and return data. They show useful
execution with a material compute overhead; they do not establish worst-case
costs or performance for other programs or input distributions. In particular,
the key comparison's cost depends on how many leading 8-byte chunks two public
keys share.

The current `benchmark:amm` run passed the source-law mutations, byte-identical
rebuild, AMM SBF integration tests, matched fixtures and repeated CU readings.
The promoted runtime source also passed the isolated full `npm test` suite,
including 87 Rust/SBF tests with zero failures and four intentional ignores:
`build/wide-native64-scout/regression-audit.json`. Evidence applies to its
recorded source snapshot. Division, multiplication and native
lowering checks are reported separately in [refinement](refinement.md).

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

A 2026-10-03 refresh used an isolated copy of this driver with the existing
Cargo cache. Both runs passed; production ELF/report hashes stayed unchanged.
Evidence is `build/amm-phase-refresh-20261003/audit.json`. For the successful
base-to-quote swap, the diagnostic intervals were:

| Interval | Bend CU | Rust CU |
| --- | ---: | ---: |
| State/instruction decode and clock/context | 1,744 | 2,250 |
| Business transition | 4,111 | 733 |
| State encoding, effect preparation and validation combined | 2,516 | 1,143 |
| CPI loop, including Token Program execution | 15,824 | 14,708 |

The transition has the largest difference in this diagnostic fixture. These
readings identify where to investigate; they include instrumentation effects
and do not assign the production gap to individual compiler operations.

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
diagnostic's successful swap now spends 29,210 CU in Bend versus 23,703 CU in
Rust. Bend spends 1,557 CU from transition to state encoded, 363 CU on effect
conversion, and 596 CU on effect validation; Rust spends
147 CU on result mapping, 239 CU on payload encoding, and 757 CU on effect
validation. The bounded state copy reduced Bend's token-executed-to-state-written
interval from 1,873 to 127 CU; Rust spends 128 CU there. The Bend/Rust
decoded/clock-to-transition gap is 3,650 CU. These
figures include marker overhead and apply only to the recorded fixtures and
diagnostic binaries. Rust's effect construction is included before its
transition marker, so the 363 CU conversion interval has no matching Rust
post-transition step.
