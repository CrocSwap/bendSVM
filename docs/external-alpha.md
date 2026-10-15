# External experimental alpha

Status: bounded, experimental alpha. This is a developer workflow and live
deployment milestone, not a production release, security audit, or end-to-end
verified compiler. License selection, public hosting, and publishing a package
or repository are intentionally pending user decisions. See the
[acceptance record](external-alpha-acceptance.md) for current commands and
evidence.

## Supported setup

The checked-in CI workflow targets Ubuntu 22.04, Node 22, Bun 1.4.2 from the npm
lockfile, Rust/Cargo 1.92.0, and Anza platform-tools v1.53 and v1.57. This validation was
run from a clean source copy on macOS arm64; it does not claim a GitHub Actions
or Linux execution. Live validation additionally needs Solana CLI and
`solana-test-validator`; ordinary project creation, checking, building and
LiteSVM tests do not need a wallet or RPC endpoint.

Install the OS tools (Node/npm, Git, Rust/Cargo, curl and a host Clang), then
install Anza platform-tools. Project targets (Fogo and Solana) use v1.57:
`npm ci && npm run install:platform-tools` installs it (macOS arm64, Linux
x86_64/aarch64; `npm run bootstrap:alpha` does this too). Untargeted historical
builds and `npm test` fixtures use v1.53. Python 3 is only needed for the
optional refinement suite. For v1.53 on macOS arm64:

```sh
TOOLS_ROOT="$HOME/.cache/solana/v1.53/platform-tools"
mkdir -p "$TOOLS_ROOT"
curl -fL https://github.com/anza-xyz/platform-tools/releases/download/v1.53/platform-tools-osx-aarch64.tar.bz2 \
  | tar -xj -C "$TOOLS_ROOT"
test -x "$TOOLS_ROOT/llvm/bin/clang"
export SBF_TOOLS="$TOOLS_ROOT/llvm/bin"
```

Use the corresponding Linux or macOS x64 asset on another supported host. The
v1.53 archives extract directly to `llvm/bin` (not
`platform-tools/llvm/bin`); the compiler expects `SBF_TOOLS` to name that
directory, or reuses `~/.cache/solana/v1.53/platform-tools/llvm/bin`.
Python/Z3 is not needed for the ordinary alpha workflow. For the separate
refinement suite, provision and select the pinned binding explicitly:

```sh
python3 -m venv .deps/refinement-venv
.deps/refinement-venv/bin/python -m pip install z3-solver==5.1.0
PYTHON="$PWD/.deps/refinement-venv/bin/python" npm run doctor -- --refinement
PYTHON="$PWD/.deps/refinement-venv/bin/python" npm run verify:all
```

From this checkout, the safe bootstrap is:

```sh
npm run bootstrap:alpha
npm run doctor
```

`bootstrap:alpha` runs `npm ci`, obtains the pinned Bend checkout only under
`.deps/bend`, fetches the three locked Cargo dependency graphs, and runs the
doctor. It never reads or modifies a configured wallet and never initializes a
root Git repository. `npm run doctor -- --live` additionally checks the Solana
CLI, validator and devnet `getVersion`; it does not request an airdrop.
`npm run doctor -- --refinement` is the explicit opt-in check for Python/Z3.

The doctor reports exactly what is reused. In particular, TypeScript is pinned
to `node_modules/typescript@5.2.2` and is never taken from an editor/npm cache;
the `TSC_JS` override is still accepted by the legacy packaging test but is not
needed. The normal workflow reuses the locked npm install, the pinned
`.deps/bend` checkout, Cargo registry/git caches and the explicitly rebuilt
test runner under `target/debug`, and the Anza cache (or `SBF_TOOLS`). The
ordinary workflow does not require Python/Z3; the refinement virtualenv is
used only when explicitly selected. The clean-source validation described in
the acceptance record installs npm dependencies in the source copy and reports
any reused platform-tools/Cargo caches explicitly.

## Tutorial and offline acceptance

Follow the complete hands-on walkthrough in
[external-alpha-tutorial.md](external-alpha-tutorial.md). The short command
surface is:

```sh
npm run bend -- new projects/my-program
npm run bend -- check projects/my-program
npm run bend -- verify projects/my-program
npm run bend -- build projects/my-program
npm run bend -- test projects/my-program
```

The starter lists the `fogo` and `solana` targets, and `build` and `test` run both.
The Solana target needs platform-tools v1.57, which `npm run bootstrap:alpha` (or
`npm run install:platform-tools`) installs for macOS arm64, Linux x86_64 or Linux aarch64; without it, add
`--target fogo`. See [targets](developer-workflow.md#fogo-and-solana-targets).
`test` executes the generated client against the actual SBF in LiteSVM. The
repeatable acceptance gate starts a fresh starter in an isolated staging
directory, writes all project artifacts there, explicitly rebuilds the pinned
LiteSVM test runner, demonstrates a source-law mutation being rejected by
`verify` and `build`, and records the commands and hashes in
`build/external-alpha/acceptance.json`. It does not copy a `build/*.so` or
generated client into the staged project.

The generated client is the supported application interface:

```ts
import {createClient} from './dist/program.client.js';
const client=createClient(programAddress);
const plan=client.instructions.Append({value:17},accounts);
```

It supplies canonical data and account metadata. A wallet/RPC transport signs
and submits the plan; applications with token or generic CPI effects must pass
their explicit `remaining` accounts. The live queue runner now obtains all queue
instruction plans from `build/queue.client.js` through
`scripts/live-queue/generated-client.ts`; Rust owns only the transaction/RPC
harness and standard SPL setup. A general wallet/RPC transport package is a
separate follow-up, so the runner is validation tooling rather than a claimed
production SDK.

## Live acceptance

Build the queue from source before a live run:

```sh
npm run build:program -- examples/queue/PROOF.bend queue.process build/queue examples/queue/storage.json
cargo run --locked --manifest-path scripts/live-queue/Cargo.toml \
  --target-dir target/live-queue -- http://127.0.0.1:18899
```

For local validation, start a fresh validator ledger in another terminal. Use a
free gossip port when a host service already occupies 8000:

```sh
solana-test-validator --ledger build/live-validator-ledger-<unique> \
  --rpc-port 18899 --faucet-port 18902 --gossip-port 18901 \
  --bind-address 127.0.0.1
```

Agave uses `rpc-port + 1` (18900 here) for the RPC websocket, so keep the
faucet on 18902 rather than 18900.

For devnet, use the runner's fresh program/test keys and either its fresh payer
and test-SOL faucet or an explicitly supplied funded test payer:

```sh
cargo run --locked --manifest-path scripts/live-queue/Cargo.toml \
  --target-dir target/live-queue -- https://api.devnet.solana.com
```

For a funded payer, pass its existing 0600 keypair with `--payer PATH`; the
runner reads it without copying or overwriting it, skips `requestAirdrop`, checks
and reports the public address/balance, and never falls back to another wallet:

```sh
cargo run --locked --manifest-path scripts/live-queue/Cargo.toml \
  --target-dir target/live-queue -- https://api.devnet.solana.com \
  --payer build/devnet-alpha-payer.json
```

The completed funded run is recorded in
`build/live-queue-1789957874208/report.json`: program
`3FKjGMdEd3waTe2EF4f5kc1KDqS1c3MT4BPcnPtj4tfc`, deployment signature
`2aSshG5obvbppQoFuNeu2JW7C2xm7wZsKFSr49TvW6WTGnxxQGHuBMqiKfK4KDra8TyjvhYzAhNn9pNYxFmRsCxu`,
35,192 matched ELF bytes, 17 confirmed receipts, custom 17 rollback and custom
258 replay rejection, final balances 36/18, zero custody, final state cursor 3
(closed), and payer final balance 1.566049960 SOL. A preceding attempt hit HTTP 429 during status lookup;
its known signature was checked and finalized before the fresh run, with no blind
resubmission.

The runner uses `solana program deploy --use-rpc`, checks the executable account,
dumps and compares the deployed ELF bytes, then runs the token lifecycle. It
records a locally known signed signature in `receipts.json` before each RPC
submission and retries only read-only status checks. A submitted signature whose
confirmation times out or whose response is unresolved is recorded as
`outcome: "uncertain"`; it is never reported as a pass or failure without a
status lookup and must not be blindly resubmitted. A failed CLI loader deployment
is separately recorded in `deployment-uncertain.json` with saved stdout/stderr.
Only a completed run writes `report.json`. Those directories contain private test
keys and must remain local; CI uploads only explicit safe reports/manifests and
never `live-queue-*` directories or key files.

The accepted local and devnet evidence covers loader deployment, deployed
executable bytes, token funding/settlement, late-CPI rollback, final
balances/custody and replay rejection. If faucet, DNS, RPC or confirmation fails,
record the exact error and do not call that run passed.

Current local evidence is
`build/live-queue-1789956354159/report.json`, with independent receipts in
`build/live-queue-1789956354159/receipts.json` (18 confirmed receipts, 35,192
matched ELF bytes, final recipient balances 36/18 and zero custody). The local
validator was owned by the validation PTY and terminated after the pass. The
funded devnet report and receipts are retained in the paths above; a failed CLI
deployment preserves its stdout/stderr and separate uncertainty record but still
requires manual signature status inspection.

Source laws and separate SMT refinements establish only the declared source
properties and modeled refinements. They do not verify compiler lowering,
LLVM/loader behavior, the deployed ELF, or arbitrary CPI callees. Existing
subset, stack, wire-size, compute and trusted-component limitations remain.

## Roadmap and release boundary

The next useful work is a separate wallet/RPC transport integration around the
generated plans, independent review, and a small guided developer trial. Before
any public release, the owner must choose a license, hosting/repository policy,
and whether to publish artifacts. Production safety, mainnet support, token-2022,
general account lifecycle ergonomics and end-to-end compiler verification are
outside this alpha.
