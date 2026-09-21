# Director handoff — 2026-09-20

Repository update: this checkout now has an initial Git history, root CI and a
GPL-3.0-only project license. The notes below preserve the earlier handoff's
historical context; current source and repository metadata take precedence.

## Start here

This is an experimental Bend 2 → Solana SBF compiler, SDK and developer workflow.
The user wants to explore whether Bend's source verification can make it a useful
Solana development language. The project has progressed beyond an isolated proof
of concept. It is not a production tool or an end-to-end verified compiler.

Read, in order:

1. `README.md`: capabilities, applications, prerequisites and quickstart.
2. `docs/developer-workflow.md`: current user experience and guarantee boundaries.
3. `docs/developer-workflow-acceptance.md`: latest completed milestone and gates.
4. `docs/subset.md` and `docs/diagnostics.md`: supported language and target limits.
5. `docs/account-collections-acceptance.md`: preceding collection milestone.
6. `scripts/live-queue/README.md`: prepared live validation and its actual status.

These paths are relative to the repository root. This document preserves session
context; source files and fresh test results take precedence if they change.

## Completed work

- Shared compiler: checked Bend runtime terms → freestanding C → pinned Anza
  Clang/LLD → actual SBF ELF. Application logic does not require custom C branches.
- Six applications: vault, vesting, fixed-price exchange, constant-product AMM,
  batch settlement, and paged settlement queue.
- SDK: canonical codecs, authorization, managed state, PDA custody, original SPL
  Token transfers/mint/burn, bounded generic CPI and account-backed collections.
- Source laws and separate application-specific SMT refinements; differential,
  adversarial, rollback and Rust comparison tests.
- Latest completed goal: a developer can create, build, verify and exercise an
  account-backed Bend program without writing C or manually encoding instructions.
  Commands: `npm run bend -- new|check|verify|build|test <project>`.
- Collection starter includes laws/proofs and offline tests. Generated typed
  clients provide instruction construction and account/state decoding. Portable
  client outputs have independent packaging and TypeScript checks.

The account-collection and developer-workflow goals were both marked complete.
No new implementation goal was approved after the roadmap discussion.

## Evidence and its limits

Latest workflow acceptance records:

- 78 existing SBF regression tests passed; zero failures; three benchmark-only
  tests ignored by the normal runner.
- Fresh collection and existing single/multi-account projects: 14 transactions,
  nine successes, five expected rejections, 31 assertions.
- Seven public program builds reproduce artifacts; portable client execution and
  positive/negative TypeScript checks passed.
- Final evidence audit: `scripts/audit-developer-workflow.ts`; snapshot:
  `build/developer-workflow-acceptance.json`.

The preceding collections milestone ran the full differential suite and all 17
source refinement commands. The workflow milestone did not rerun the unrelated
long arithmetic SMT suite. Historical acceptance snapshots can become stale when
sources change; do not present old hashes as current validation. Exact workflow
reproduction commands and requirements are in its acceptance document.

SBF execution so far is in LiteSVM. `verify` checks the laws the developer supplied;
it does not generate specifications or automatically run arbitrary SMT proofs.
The compiler, lowering, arithmetic models/primitives, LLVM, adapter/runtime and
external programs remain part of the trust boundary.

## External-alpha validation and live deployment

`scripts/live-queue/` contains the deployment/integration runner. It uses fresh
test keys and test-SOL funding, deploys the queue, compares deployed bytes,
executes token settlement, checks late-CPI rollback and rejects replay. Queue
instruction plans now come from the generated `build/queue.client.js` through
`scripts/live-queue/generated-client.ts`; Rust is the transaction/RPC and SPL
harness. It supports public devnet or localhost port 18899.

The external-alpha workflow now removes stale acceptance evidence, distinguishes
semantic law rejection from spawn/signal failures, makes Z3 opt-in via
`npm run doctor -- --refinement`, and runs the complete `npm test` fixture/SBF
suite before generated-client consumers. The checked-in CI target is Ubuntu
22.04, but local review claims only the macOS arm64 clean-source copy recorded
in `docs/external-alpha-acceptance.md`; no GitHub/Linux execution is claimed.
Its upload step now names only safe reports/manifests/client artifacts and does
not upload `build/live-queue-*`, payer/key files or live run directories.

The fresh local validator validation passed in
`build/live-queue-1789956354159/report.json`: program
`4A8a63eVpuAUwmeso3XqojCg2TXZi2G2aUtQWiKeHRL9`, 35,192 deployed ELF bytes
matched, all token lifecycle/rollback/replay assertions passed, and 18
confirmed signatures are recorded. The independent receipt is
`build/live-queue-1789956354159/receipts.json` with SHA-256
`5d94638f4cbef9e3fe133fac5c78a1958f830fe1e5e4ef00928bd21cc454416b`; the
validator was terminated after the run and no process remains on port 18899.
The successful funded public devnet validation is
`build/live-queue-1789957874208/report.json`, with receipts in
`build/live-queue-1789957874208/receipts.json` and deployment output in its
`deployment.stdout`/`deployment.stderr`. It used payer
`3mmqmr37YoPaAj815rp6qbWWw3Zx648gVAaZ8JGZGN26` in `supplied-payer` mode,
started at 1.812247120 SOL and ended at 1.566049960 SOL. Program
`3FKjGMdEd3waTe2EF4f5kc1KDqS1c3MT4BPcnPtj4tfc` deployed with signature
`2aSshG5obvbppQoFuNeu2JW7C2xm7wZsKFSr49TvW6WTGnxxQGHuBMqiKfK4KDra8TyjvhYzAhNn9pNYxFmRsCxu`.
The executable account and 35,192 deployed ELF bytes matched; all 17 lifecycle
receipts were confirmed, including rollback custom 17 and replay rejection custom
258, with final recipient balances 36/18, zero custody, final state cursor 3
(closed), and final state checks.
The exact reproducible command is:

```sh
cargo run --locked --manifest-path scripts/live-queue/Cargo.toml \
  --target-dir target/live-queue -- https://api.devnet.solana.com \
  --payer build/devnet-alpha-payer.json
```

A preceding funded attempt hit HTTP 429 while checking a submitted transaction;
its known signature was checked directly and finalized, so it was not blindly
resubmitted. The runner now flushes each locally known signed transaction
signature before submission, retries only read-only status checks, and records
unresolved confirmation as `outcome: "uncertain"`. CLI deployment uncertainty is
kept separately in `deployment-uncertain.json` with stdout/stderr for manual
inspection. Never claim an incomplete run from a partial report.

Only a completed runner writes its success `report.json`. Partial output is not
success evidence. Live-run directories may contain private test keys and must not
be included in a public release.

## Recommended next milestone (proposed, not yet authorized)

An external developer can start on a clean supported machine, create and modify
A Bend program, check a declared property, run its SBF tests, and exercise the
same artifact through the local deployment runner using the documented workflow.
The external-alpha setup, isolated gate, local live evidence and one funded public
devnet run are now present; a general wallet/RPC transport around generated plans
remains separate work.

Suggested order:

1. External-alpha packaging: release hygiene, pinned setup, prerequisite
   diagnostics, CI, one complete tutorial and fresh-machine reproduction.
2. Invite roughly 3–5 experienced Solana developers to try their own small apps.
3. Prioritize language/SDK/proof-ergonomics gaps from those experiments, alongside
   compute improvements; avoid pursuing full language coverage without use cases.
4. Treat production hardening and independent review as a separate milestone.

The assessment communicated to the user: technically ready for a small guided
experimental alpha, but not yet a frictionless self-serve or production release.
This was a recommendation, not authorization to publish or message outsiders;
the owner has since explicitly selected GPL-3.0-only for the project.

## Practical constraints and orientation

- At the 2026-09-20 handoff, this checkout had no root Git repository, root
  license or CI configuration; that historical state is preserved here for
  context. The current checkout has an initial Git history, root CI and a
  GPL-3.0-only project license. `package.json` remains private. Check before
  assuming any external repository exists. Do not discard the working tree or
  build evidence.
- The clean-source macOS validation is recorded in
  `docs/external-alpha-acceptance.md`; no GitHub/Linux execution is claimed.
  Build dependencies include pinned Bend, Bun, Rust, Anza tools and host Clang.
  Python/Z3 is only for explicitly selected extended refinement checks. See
  README for versions. The offline runner requires Cargo dependencies fetched
  first. Client packaging gates use pinned `node_modules/typescript@5.2.2`;
  an explicit `TSC_JS` override is accepted only when it reports that version.
- Starter sources reference the shared SDK in this checkout; generated clients
  are portable. Clients construct instructions but do not provide wallet/RPC
  transport integration.
- Language restrictions include bounded iteration, concrete nonrecursive data,
  no runtime closures or general recursion, and fixed resource limits. Specialized
  token support is original SPL Token; general account lifecycle ergonomics need
  more work. Use the subset document for exact constraints.
- Queue settlement benchmark is roughly 2.3–2.5× the independent Rust baseline's
  compute use in measured fixtures; this is not a worst-case bound.
- Key implementation entry points: `scripts/bend.ts`, `scripts/build.ts`,
  `scripts/program.ts`, `compiler/`, `runtime/`, `sdk/program-client.ts`,
  `sdk/testing.ts`, `scripts/test-runner/`, `templates/collection/`, `verification/`.
- Current session allowed workspace writes but restricted network, with approvals
  disabled. A new session must follow its own actual permission configuration.
- Do not assume a new agent inherits chat history. Use this file and the linked
  acceptance documents, then establish the user's next requested action.
