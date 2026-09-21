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

| Transaction | Bend CU | Rust CU | Bend / Rust |
| --- | ---: | ---: | ---: |
| Initialize | 83,277 | 36,082 | 2.31× |
| Deposit | 72,397 | 28,512 | 2.54× |
| Swap base for quote | 64,221 | 22,684 | 2.83× |
| Swap quote for base | 64,210 | 22,684 | 2.83× |
| Withdraw | 72,687 | 28,548 | 2.55× |
| Reject slippage | 35,318 | 6,958 | 5.08× |
| Reject zero input | 28,531 | 6,509 | 4.38× |
| Reject locked-share withdrawal | 28,438 | 6,414 | 4.43× |

The Bend ELF is 63,480 bytes; the Rust ELF is 43,304 bytes. These are complete
program measurements, including decoding, validation, custody derivation,
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
