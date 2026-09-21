# Live queue validation

Status: local and public devnet live validation passed on 2026-09-20. The
successful devnet report is `build/live-queue-1789957874208/report.json`; its
independent receipts are in `receipts.json`. The runner builds queue instruction
plans through the generated `build/queue.client.js` artifact and
`generated-client.ts`; Rust owns transaction/RPC signing and standard SPL setup.

Run from the repository root with Rust, curl and the Solana CLI installed. The
runner supports exactly the public devnet URL or local port 18899. It creates
fresh program and test-account keys and never uses the configured CLI wallet. By
default it also creates a fresh payer and requests 2 test SOL from the faucet.

For an explicitly funded test payer, pass `--payer PATH`. The runner reads that
keypair without copying or changing it, requires mode 0600, skips the faucet,
checks its devnet balance, and reports the public address plus `fundingMode` in
stdout and `report.json`:

```sh
cargo run --locked --manifest-path scripts/live-queue/Cargo.toml \
  --target-dir target/live-queue -- https://api.devnet.solana.com \
  --payer build/devnet-alpha-payer.json
```

Only `https://api.devnet.solana.com` and `http://127.0.0.1:18899` are accepted;
mainnet and other local/RPC URLs are rejected. A zero or insufficient payer
balance fails with the exact observed balance and no wallet fallback.

Build the Bend program:

```sh
npm run build:program -- examples/queue/PROOF.bend queue.process build/queue examples/queue/storage.json
```

For a local validator, first run this in a separate terminal (use a fresh ledger
directory if that path already belongs to another validator):

```sh
solana-test-validator --ledger build/live-validator-ledger --rpc-port 18899 --faucet-port 18902 --gossip-port 18901 --bind-address 127.0.0.1
```

The validator uses `rpc-port + 1` (18900 here) for its websocket, so the
faucet must use a different port.

Then:

```sh
cargo run --locked --manifest-path scripts/live-queue/Cargo.toml --target-dir target/live-queue -- http://127.0.0.1:18899
```

The runner deploys through `solana program deploy --use-rpc` (required for the
current CLI/validator combination), checks the executable account,
downloads the program and compares its bytes to `build/queue.so` (allowing only
zero allocation padding). All application interactions then use signed
transactions submitted over RPC, with confirmed signature statuses. A general
wallet/RPC transport is not yet part of the generated client; this runner is
deployment validation tooling, not a production SDK.

It creates a test mint, token accounts, state and an 11,064-byte collection; funds
three obligations totaling 54 units; seals them; freezes the second recipient;
submits a two-payment settlement that must fail on-chain and preserve all managed
accounts; thaws the recipient; settles pages of two and one; verifies balances
36/18, empty custody, cursor progress and closed state; and verifies on-chain
replay rejection without account changes. Fees are excluded from rollback checks.

Each run has a unique `build/live-queue-<timestamp>` directory containing private
test keys (mode 0600), the build manifest, deployment output and downloaded ELF.
For a supplied payer, the external key is not copied into this directory.
`receipts.json` is flushed before each locally signed transaction is submitted,
so a dropped response leaves its public signature available for status lookup;
the runner retries only read-only status checks and never blindly resubmits an
uncertain non-idempotent transaction. Confirmation timeouts or unresolved RPC
responses remain `outcome: "uncertain"`. A failed Solana CLI deployment is
separate `deployment-uncertain.json` evidence; inspect its saved stdout/stderr
and signature before any retry. Only complete success writes `report.json` with
cluster identity, program/account addresses, deployment signature, payer
balances, confirmed transaction signatures and assertions' final values. Never
publish the run directory or its key files.

The completed public devnet run used payer
`3mmqmr37YoPaAj815rp6qbWWw3Zx648gVAaZ8JGZGN26`, started at 1.812247120 SOL
and ended at 1.566049960 SOL. Program
`3FKjGMdEd3waTe2EF4f5kc1KDqS1c3MT4BPcnPtj4tfc` deployed with signature
`2aSshG5obvbppQoFuNeu2JW7C2xm7wZsKFSr49TvW6WTGnxxQGHuBMqiKfK4KDra8TyjvhYzAhNn9pNYxFmRsCxu`.
The report records 35,192 matched executable bytes, 17 confirmed transaction
receipts, rollback custom 17, replay rejection custom 258, recipient balances
36/18 and zero custody.

The wire layout is pinned to the current queue interface, with descriptor checks.
This runner is a deployment integration test, not a production client or a new
formal-verification claim. The run directories contain private keys and stay
local; CI uploads only explicitly selected safe reports/manifests, never
`live-queue-*` directories or key files.
