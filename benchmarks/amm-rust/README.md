# Independent Rust AMM baseline

This is a comparison implementation of the [Bend pool protocol](../../docs/amm.md).
It is intentionally separate from generated Bend C:

- `pricing.rs`: native u128 quotes and Newton integer square root.
- `transition.rs`: pure pool state transitions and token effects.
- `wire.rs`: canonical encoding for the public AMM interface.
- `main.rs`: Solana loader/account validation, custody derivation and token CPIs.

Build with `npm run build:amm-rust` from the repository root. The command uses
the Rust compiler/core libraries from Anza platform-tools v1.53, checks a
byte-identical rebuild, and writes `build/amm-rust.so` and its source/toolchain
manifest. It does not use the host Rust compiler to build the SBF binary.

Use `npm run benchmark:amm` to build both implementations, run the shared SBF
conformance suite, and produce repeated measurements on identical fixed
fixtures. See [the benchmark guide](../../docs/amm-benchmark.md) for results and
scope. The wire header is intentionally fixed to this version of the AMM state
schema; shared tests detect disagreement with the generated Bend interface.

Neither this baseline nor the Bend program has an independent production audit.
