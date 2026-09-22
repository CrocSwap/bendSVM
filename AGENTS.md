# Agent guide

## Project and orientation

bendSVM is an experimental bounded Bend 2 → Solana SBF compiler, shared SDK,
and developer workflow. Checked Bend runtime terms lower to freestanding C;
pinned Anza Clang/LLD produce SBPFv0 programs exercised in LiteSVM. Application
business rules belong in Bend, without application-specific compiler branches
or handwritten application C.

Start with `README.md` and `docs/HANDOFF.md`. Then read the documents relevant
to the task:

- `docs/developer-workflow.md` and `docs/external-alpha.md`: project CLI,
  prerequisites, generated clients and experimental alpha workflow.
- `docs/subset.md`, `docs/diagnostics.md`, `docs/interfaces.md`: supported
  language, resource limits and account/wire contracts.
- `docs/refinement.md` and application-specific documents: verification scope,
  assumptions and evidence.
- `.github/workflows/external-alpha.yml`: actual CI commands and ordering.

Source, current repository metadata and fresh results take precedence over
historical handoff notes or acceptance snapshots. The handoff contains proposed
future work, not an instruction to start a new milestone. Recent work added AMM
backing invariants in `verification/amm.py` and documented their scope in
`docs/amm.md` and `docs/refinement.md`.

## Repository map

| Path | Responsibility |
| --- | --- |
| `compiler/backend.ts` | Checked source loading, proof gate, subset validation and C lowering |
| `compiler/` | Schemas, canonical codecs, dispatch, storage/effect adapters, typed clients, diagnostics and artifacts |
| `runtime/` | Freestanding C runtime, Solana/CPI ABI headers and SBF linker script |
| `sdk/` | Bend arithmetic, context, effects, bounded containers and collections; TypeScript client/testing support |
| `examples/` | Vault, vesting, exchange, AMM, batch and queue; historical escrow POC |
| `scripts/bend.ts` | Project CLI: `new`, `check`, `verify`, `build`, `test` |
| `scripts/build.ts`, `scripts/program.ts` | Pinned dependency/toolchain setup and SBF build pipeline |
| `templates/collection/` | Starter program, declared laws, proofs and offline test |
| `tests/`, `scripts/test.ts` | Source mutations, differential/native tests, fixtures and Rust SBF tests |
| `verification/` | Checked-source model exporter, Python/Z3 proofs, negative checks and reports |
| `benchmarks/` | Independent Rust implementations for matched comparisons |
| `scripts/test-runner/` | Rust LiteSVM runner used by project tests |
| `scripts/live-queue/` | Local-validator/devnet deployment and integration harness |

`build/`, `target/`, `.deps/`, `node_modules/` and `.fadeno/` are ignored local
outputs/dependencies/state. Do not edit generated artifacts as a source fix or
discard existing evidence. Generate changes through their owning source files.

## Setup and commands

Run commands from the repository root. `package.json` is the command inventory;
there is no generic lint or TypeScript-check script. TypeScript runs under the
pinned Bun installed by `npm ci`.

Toolchain pins are Bun 1.4.2, TypeScript 5.2.2, Anza platform-tools v1.53
(Clang 20.1.7), and LiteSVM 0.7.1. Rust 1.92.0 is the documented/CI version.
The build requires a clean `.deps/bend` checkout at
`7561656155a4285c1e4ccfcb3505ab59524de973`; do not bypass this check.
`SBF_TOOLS` overrides the Anza `llvm/bin` directory, `CC` selects host Clang,
and `PYTHON` selects the interpreter for optional refinements. Those refinements
require the Z3 binding reporting 5.1.0; follow the virtualenv instructions in
`docs/external-alpha.md`, without installing global Python packages.

```sh
npm ci
npm run doctor
npm test
```

For initial provisioning, `npm run bootstrap:alpha` installs/checks the documented
dependencies. For an individual program:

```sh
npm run build:program -- examples/vault/PROOF.bend vault.process build/vault
```

An optional fourth argument supplies the storage layout JSON. `npm run build`
builds the historical escrow fixture, not all applications.

For a new project, use `npm run bend -- new <project>` and then
`npm run bend -- check|verify|build|test <project>` with one command at a time.
`verify` checks the declared Bend laws; it does not automatically run the
application-specific SMT suite. Generated clients construct instruction plans;
wallet/RPC transport is separate.

## Validation

Choose checks based on the changed behavior and report what actually ran.
Documentation-only edits normally need a diff/link/command review, not the full
compiler suite.

- `npm test` builds fixtures and runs proof-rejection, reference/native,
  sanitizer, codec, application, reproducibility and Rust SBF checks. Shared
  compiler/runtime/ABI changes warrant this broader regression suite.
- Focused scripts include `npm run test:amm`, `test:queue`, `test:batch`,
  `test:collection`, `test:buffer`, `test:iteration` and `test:generics`.
  Inspect their entrypoints for fixture and tool prerequisites.
- After fixture generation, a Rust subset can be run with
  `cargo test --locked --test sbf <filter> -- --nocapture`. Running Cargo alone
  does not regenerate program artifacts.
- For CLI/client changes, follow CI ordering: run `npm test` before
  `npm exec -- bun tests/program-client.ts`,
  `npm exec -- bun tests/project-commands.ts`, and
  `npm exec -- bun tests/client-packaging.ts`.
- `npm run acceptance:alpha` runs the isolated external-alpha gate.
- `npm run verify:all` runs 17 separate source refinement commands and writes
  `build/refinement-suite.json`. Use focused `verify:*` commands for relevant
  proof changes; these checks are separate from ordinary regression tests.
- Benchmark commands are `npm run benchmark:amm`, `benchmark:batch`, and
  `benchmark:queue`; consult their documents for matched comparison conditions.

Preserve meaningful negative tests: unsupported inputs must reject, faulty source
mutations must fail for the expected semantic reason, and failed transactions
must preserve the account state required by their rollback contracts. A timeout,
spawn failure or partial report is not a successful proof or acceptance run.

## Implementation and evidence rules

- Preserve the proof gate: adjacent laws must be imported, open laws/proof holes
  and unsafe/foreign dependencies must reject, and proof functions stay outside
  the runtime closure.
- Keep compiler/SDK behavior generic. Follow existing code style in the touched
  module and avoid unrelated formatting or dependency churn.
- Preserve canonical encodings, account authorization/alias checks, checked
  arithmetic and atomic effects. ABI changes need corresponding codecs, client,
  runtime tests and documentation updates.
- Respect documented target bounds, including 1,536-byte native values,
  1,024-byte canonical wire values, 4,096-byte SBF stack frames and bounded
  Nat-fueled iteration. Unsupported constructs must fail explicitly.
- Keep Bend law checking, SMT source refinements, runtime tests, reproducibility
  and live deployment evidence distinct. None establishes an end-to-end verified
  compiler or production readiness. State proof assumptions and measured scope.
- Treat acceptance reports as evidence for their recorded inputs/hashes, not
  perpetual validation of later edits. Update relevant documentation when
  guarantees, supported behavior or workflow change.
- The project license is GPL-3.0-only; dependencies retain their own licenses.

## Live validation and handoffs

Ordinary builds and tests need no wallet, RPC connection or deployment. Use the
live runner only within the user's requested scope and consult its README.
Live-run directories can contain private test keys: never publish/upload them,
payer files or wallet material. CI deliberately uploads selected safe artifacts.

Only a completed live runner's success report establishes a completed run.
For an uncertain submission, inspect recorded signatures and read-only status
before considering a resubmission; do not blindly repeat transactions.

When handing work over, record the concrete changes, commands/results, evidence
paths, remaining limitations and next requested action. Distinguish recommendations
from authorized work and avoid assuming the next agent has conversation history.
