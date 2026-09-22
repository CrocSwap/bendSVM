# Local-validator project tests

`npm run bend -- test <project>` remains the offline LiteSVM test. To run the same project `test.ts`, generated client, and `TestProgram` instructions against a freshly funded local validator, use:

```sh
npm run bend -- test projects/my-program --local-rpc http://127.0.0.1:18899
```

The local transport accepts exactly `http://127.0.0.1:18899`. It rejects other ports, hostnames, network interfaces, HTTPS endpoints, devnet and mainnet. It does not read a configured Solana wallet or accept a supplied payer. Rust 1.92.0, Cargo's locked dependencies, Solana CLI 3.0.15, and `solana-test-validator` 3.0.15 are required. Fetch the local runner's pinned dependency graph once, then the project command builds it in Cargo offline mode:

```sh
cargo fetch --locked --manifest-path scripts/local-runner/Cargo.toml
```

Run a fresh validator ledger in a separate terminal. These ports leave the validator's websocket at 18900 and faucet at 18902:

```sh
solana-test-validator --ledger build/local-validator-ledger-1 \
  --rpc-port 18899 --faucet-port 18902 --gossip-port 18901 \
  --bind-address 127.0.0.1
```

Each invocation creates fresh payer, program and named account keys in a unique `build/local-test-*` directory. The directory is mode `0700`; key and receipt files are mode `0600`. Do not upload or publish these run directories. The payer receives a local-validator airdrop. The built ELF is deployed with `solana program deploy --use-rpc`; the runner checks that the program account is executable and dumps it back to compare every byte, allowing only zero allocation padding after the ELF.

Account creation is signed, rent-exempt, and atomic with an optional initializer. Generated plans become signed, confirmed transactions. Expected program errors are confirmed on-chain and include transaction logs and custom codes. `t.reject` compares the affected application accounts before and after while excluding the fee payer, whose balance changes to pay transaction fees. Named keys remain stable within a run and are random across runs.

Before each locally signed transaction is submitted, its public signature is flushed to `receipts.json`. Confirmation retries only read-only signature-status queries. The runner never resubmits a transaction whose submission response is uncertain. Deployment stdout/stderr and a separate uncertainty record survive a failed `solana program deploy`; inspect the recorded signature before considering any retry. Child processes and individual RPC requests have bounded timeouts and are cleaned up if the runner is terminated.

Only a clean runner exit after the test's required program calls and assertions writes `<output-stem>.local-test-report.json`. The local report is separate from the offline `<output-stem>.test-report.json`; a new local test attempt removes its prior success before dependency checks or build work. It records the RPC endpoint and validator version, source-manifest and ELF hashes, test/config/client and runtime/runner input hashes, executable-byte match, run and receipt paths, actual public signatures, transaction summary and test receipts. Failures leave receipts and failure evidence in `build/local-test-*`, but never create a local success report. This is live local execution evidence, not a proof that the compiler, validator or application is production safe.
