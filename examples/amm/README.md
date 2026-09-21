# Constant-product AMM

The Bend program now implements initialization, deposits, withdrawals and both
swap directions with real SPL Token integration. See the [application guide](../../docs/amm.md)
for account preparation, the TypeScript client and the focused `npm run test:amm`
command. Source refinements and the complete Rust SBF comparison pass the
[acceptance audit](../../docs/amm-acceptance-audit.md). The
[milestone specification](../../docs/amm-plan.md) defines the completed scope.

## Read the arithmetic

- [pricing.bend](pricing.bend) implements the upward-rounded 30 bps fee,
  exact-input swap quote, ceiling deposit payments and floor withdrawal receipts.
  Amounts and reserves are unsigned 64-bit token base units, not decimal prices.
- [../../sdk/wide.bend](../../sdk/wide.bend) supplies full-width intermediate
  multiplication and division. The compiler does not recognize AMM operations.
- [../../sdk/sqrt.bend](../../sdk/sqrt.bend) calculates an integer square root
  using exactly 64 trial bits. Its geometric mean supplies initial LP accounting
  shares; the pool will reserve 1,000 locked shares before issuing user shares.
- [LAWS.bend](LAWS.bend) and [PROOF.bend](PROOF.bend) state and discharge local rejection properties. The separate
  `npm run verify:amm` refinement checks the full transition.
- [Rust arithmetic](../../benchmarks/amm-rust/pricing.rs) implements the same
  economic rules independently, using Rust's native u128 operations.
- [Shared issuance SDK](../../sdk/issuance.bend) provides three atomic effects,
  PDA-controlled minting, owner-authorized burning, and exact reserve-address
  bindings. Its [interface documentation](../../docs/interfaces.md#custody-controlled-issuance)
  describes the runtime checks and the authorization left to Bend applications.

For reserves of 10,000 units each, a gross input of 1,000 incurs a fee of 3.
The effective input is 997, so output is `floor(10,000*997/10,997) = 906`.
Recorded reserves become 11,000 and 9,094: their product is 100,034,000,
which exceeds the original 100,000,000. The fee stays with liquidity providers.

The functions return `Math.Checked`. Errors 1–3 mean overflow, underflow or
division by zero; error 4 means invalid economic inputs or zero output. Quotes
do not inspect accounts or authorize transfers. The transition also enforces signatures, account bindings, locked liquidity and user limits.

## Reproduce the arithmetic checks

Install the [root prerequisites](../../README.md#build-and-test), then run from
the repository root:

```sh
npm ci
npm run test:amm-math
```

This command checks Bend laws (including deliberately broken variants), compares
588 pricing and 111 square-root cases with independent integer oracles, runs
sanitized native code, builds and executes SBF artifacts in LiteSVM, and checks
the independent Rust arithmetic against the same vectors. Reference evaluation
of the 64-step square root can take several minutes. No wallet or RPC is needed.

Generated evidence goes in `build/amm-pricing-vectors.json`,
`build/sqrt-vectors.json`, and the corresponding `*-metrics.json` files. The
metrics describe pure arithmetic fixtures; they are **not** the promised
complete-program Rust-versus-Bend benchmark. Run `npm run benchmark:amm` for the complete-program comparison, including
account validation and real SPL Token CPIs on both sides. See the
[benchmark guide](../../docs/amm-benchmark.md).

To exercise the shared token additions independently of AMM arithmetic:

```sh
npm run test:token-sdk
```

This builds small executor probes and checks real SPL mint/burn/transfers,
transferable receipts, reserve address substitution, unsafe initial custody,
three-effect rollback, and one-/two-state commits. These probes deliberately
accept caller-controlled effects and must not be deployed as applications.
