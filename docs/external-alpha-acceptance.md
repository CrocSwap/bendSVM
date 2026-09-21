# External alpha acceptance

Status: accepted as a bounded experimental alpha for the clean-source offline
workflow, local validator deployment, and one funded public devnet lifecycle.
GitHub/Linux execution remains unverified in this review. License, hosting and
production limitations remain explicit below.

## Evidence from this checkout

- `npm run acceptance:alpha` passed in the isolated staged project recorded at
  `build/external-alpha/acceptance.json`: starter create/check/verify/build/test,
  5 successful LiteSVM transactions, 3 expected rejections and 16 assertions.
  A deliberate `Rejected{1}` → `Rejected{4}` implementation mutation was
  rejected by both `verify` and `build`. The report includes SHA-256 inputs and
  output hashes plus the exact reused toolchain paths.
- `npm exec -- bun tests/program-client.ts`, `tests/project-commands.ts` and
  `tests/client-packaging.ts` passed; packaging used pinned TypeScript 5.2.2.
- `cargo test --locked --test sbf -- --nocapture` passed: 78 passed, 0 failed,
  3 benchmark-only tests ignored.
- Historical local validator report: `build/live-queue-1789952241422/report.json`.
  Cluster is `http://127.0.0.1:18899`, program is
  `2kw5vzDiz3mm7fEZdeuzcR1KjZYJhuQBKA8r9UgqNWob`, deployment signature is
  `4Ef4EC6RQi8xovofa9Ygdaop5RnbtD2fwj6j98wkaD5UhHSQFLdAoccwqRpweYJPi5VxRygTSSRDEqVbJXUyuCzR`,
  and 35,192 ELF bytes matched the source artifact. The report contains all
  confirmed transaction signatures, including late-CPI failure custom 17 and
  replay rejection custom 258, plus final balances 36/18 and zero custody.
- Fresh local-validator rerun: `build/live-queue-1789956354159/report.json`.
  It used a new local ledger, fresh payer/program/state/collection/test keys,
  and the existing `scripts/live-queue/generated-client.ts` bridge. Program
  `4A8a63eVpuAUwmeso3XqojCg2TXZi2G2aUtQWiKeHRL9`, 35,192 ELF bytes matched,
  18 confirmed receipts were recorded, late-CPI custom 17 and replay custom 258
  were confirmed, final recipient balances were 36/18 and custody was zero.
  Independent receipt evidence is
  `build/live-queue-1789956354159/receipts.json` (SHA-256
  `5d94638f4cbef9e3fe133fac5c78a1958f830fe1e5e4ef00928bd21cc454416b`); the
  validator was terminated by its owning PTY after the pass and no validator
  remains on the tested port.
- Funded public devnet rerun: `build/live-queue-1789957874208/report.json`
  (SHA-256 `e9673ff9909f771d6868d55faab8a1f30359e109dd0db07bef408c976d35fa7d`),
  with independent receipts in `build/live-queue-1789957874208/receipts.json`
  (SHA-256 `7c55bdd11276d62ff0c9a703764d5cb1d8562c825d71838bb12c37cb0cae82a8`)
  and deployment output in `deployment.stdout`/`deployment.stderr`. It used the
  explicitly supplied payer
  `3mmqmr37YoPaAj815rp6qbWWw3Zx648gVAaZ8JGZGN26` in `supplied-payer` mode;
  starting balance was 1.812247120 SOL and final balance was 1.566049960 SOL.
  Program `3FKjGMdEd3waTe2EF4f5kc1KDqS1c3MT4BPcnPtj4tfc` deployed with
  signature
  `2aSshG5obvbppQoFuNeu2JW7C2xm7wZsKFSr49TvW6WTGnxxQGHuBMqiKfK4KDra8TyjvhYzAhNn9pNYxFmRsCxu`.
  The executable account was confirmed, 35,192 deployed ELF bytes matched
  `build/queue.so`, all 17 lifecycle receipts were confirmed, rollback custom
  17 and replay custom 258 were observed, final recipient balances were 36/18,
  custody was zero, final state cursor was 3 (closed), and state assertions
  passed. A prior funded attempt
  `build/live-queue-1789957661157/` hit HTTP 429 while checking a submitted
  recipient-1 transaction; its signature was checked directly and found
  finalized, so it was not resubmitted; the redacted resolution is saved in
  `build/live-queue-1789957661157/status-resolution.json`. The successful run
  was fresh and did not claim the partial run as evidence.

The prior workspace bullets are retained as historical milestone evidence; the
clean-source results and funded live report above are the current acceptance
basis.

## Clean-source validation

The validation source copy is `/tmp/bendSVM-clean.GACanH` on macOS arm64. It
was created by copying source while excluding `build/`, `target/`,
`node_modules/`, `.deps/`, `.fadeno/` and any Git metadata. `npm ci` then
installed the locked Bun 1.4.2 and TypeScript 5.2.2 packages. The copy reused
only the host Cargo registry/git cache and
`SBF_TOOLS=/Users/colkitt/.cache/solana/v1.53/platform-tools/llvm/bin`; the
pinned Bend checkout and Cargo target were rebuilt in the copy.

Completed clean-copy checks so far:

- `npm run bootstrap:alpha` passed.
- Ordinary `npm run doctor` passed with `PYTHON=/definitely/missing/python`,
  proving Z3 is optional for the ordinary alpha path; the explicit refinement
  path was also provisioned in `.deps/refinement-venv` with
  `z3-solver==5.1.0` and passed `npm run doctor -- --refinement`.
- `npm run acceptance:alpha` passed. Its independent report is
  `/tmp/bendSVM-clean.GACanH/build/external-alpha/acceptance.json`; it records
  5 successful LiteSVM transactions, 3 expected rejections, 16 assertions,
  two matched law-mutation sites, semantic rejection logs, and stale-marker
  cleanup after an intentional missing-project failure.
- The full `npm test` passed: all fixture/reference/native generation completed;
  its final `tests/sbf.rs` result was 78 passed, 0 failed, 3 ignored. It ran
  before
  `tests/program-client.ts`, `tests/project-commands.ts`,
  `tests/client-packaging.ts`, and the SBF integration consumers so it created
  every required schema/interface/vector/ELF fixture. All three consumer tests
  passed, including portable strict TypeScript packaging.

The Anza v1.53 macOS arm64 archive URL was downloaded and extracted during this
review; its required paths are `llvm/bin/clang`, `llvm/bin/ld.lld` and
`llvm/bin/llvm-readelf`, and Clang reports 20.1.7-rust-dev. The corresponding
Linux x86_64 URL was also downloaded and extracted with the same direct
`llvm/bin` layout; its binary is not runnable on macOS (`exec format error`), so
the Linux workflow was not executed here and no GitHub/Linux result is claimed.

## Repeatable gate

```sh
npm run doctor
npm run acceptance:alpha
npm test
npm exec -- bun tests/program-client.ts
npm exec -- bun tests/project-commands.ts
npm exec -- bun tests/client-packaging.ts
```

`npm test` itself runs `cargo test --locked --test sbf -- --nocapture` after
generating the complete fixture set. The checked-in GitHub workflow targets
Ubuntu 22.04 but was not executed on GitHub/Linux during this review; no such
result is claimed here. Its evidence upload is explicitly limited to safe
reports/manifests/client artifacts; live `build/live-queue-*` directories and
any payer/key files are excluded.

Live validation requires a separately started local validator or the explicit
devnet endpoint. Each run uses fresh program/test keys, keeps private keys in its
local run directory, and flushes `receipts.json` before each locally signed RPC
submission. The runner records that signature as pending before submission,
retries only read-only status checks, and records `outcome: "uncertain"` after
unresolved confirmation; it must not blindly resubmit a non-idempotent
transaction. `failure.json` records RPC/curl errors. The Solana CLI loader
deployment is tracked separately: a failed CLI deployment preserves stdout,
stderr and `deployment-uncertain.json`, but requires manual signature status
inspection before retrying.

## Boundary and roadmap

Source laws and separate SMT refinements cover only their declared/modelled
properties; they do not verify compiler lowering, the loader, the deployed ELF
or arbitrary CPI callees. The generated client now supplies the queue
instruction plans used by the deployment harness. A reusable wallet/RPC
transport, independent review and a guided external trial remain next steps.
License selection, public hosting/repository policy and any published package
are pending owner decisions. Production safety and mainnet support are outside
this alpha.
