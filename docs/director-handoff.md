# Current director resume point — 2026-10-09

Read `AGENTS.md`, `README.md`, this file, then relevant source and evidence.
This checkpoint records the user's requested reset. Older parts of
`docs/HANDOFF.md`, `DIRECTOR-TAKEOVER.md` and the overnight journal contain
superseded pending-work statements. Current source and recorded terminal
results take precedence. Preserve the current workspace across reset.

## User direction and goal status

The user wants ergonomic Solana/Fogo compatibility and mixed Bend, Go and Rust
programs. They asked to continue with Bend `solana-v3` after GoSVM completed
its dual-target implementation. The ordinary-library v3 producer passed its
Rust/Bend acceptance on 2026-10-09 (below). Go v3 qualification, full-program
v3 and the broader ergonomics goal remain open.

The earlier five-item SHA/DCG/assurance/CU goal is recorded `complete` by the
goal tool. Its completion decision is
`build/overnight/quotient-refresh-20261006/final-director-completion-decision.json`;
its requirement review is `final-five-item-completion-review.json` in the same
directory. Those establish their recorded scope/inputs, not later v3 changes.
Later DCG milestones include real CUSTOM callback/fallback finality, retained
cleanup, capacity-wide SBF qualification and dispatcher/events integration.
The current task is language/target interoperability, not reopening that goal.

## Collaboration and completed v0 evidence

GoSVM is at `../goSVM`. Its agent is in a separate session; the user relays
messages. There is no GoSVM collaboration child to message. No agents were
spawned here; current instructions require explicit authorization to delegate.
No GoSVM sources were changed by this work.

Read `docs/library-artifact-contract.md` and `tests/mixed-library/fixture.md`.
Shared ABI v1 uses canonical byte arguments, a root/schema-fingerprinted C
symbol, pinned status values and a native host object for cgo. Each manifest
identifies its exact target and tool pin, basename `selection` and artifact
sizes/SHA-256. `finalElfAuthorized: false` is a library receipt; final-image
qualification belongs to the consumer. Qualified SHA active/generation
packages retain their separate publication contract and v0 gates.

Accepted Bend v0 bundle:
`build/interop/fogo-v0/20261007T134003Z-0bdd2144/library.manifest.json`.
Manifest SHA-256:
`ec18012f5bb98cd19813b721f2ec343d628c679052828a3eb122ca1b335bc6de`.
Root `mixed.evaluate`, canonical input/output 6/5 bytes, symbol
`bend_library_v1_call_56d8740a662aed7c46c81322f7df5fc1f784b2f5b418dc3d661ef9ab604195b3`.
Bend v0 uses platform-tools v1.53, ELF machine 263 / flags 0.

Before v3 edits, `npm run test:mixed-library` passed native ABI checks,
15 Rust/Bend SBF cases, proof/input/schema/target refusals and the recursive
final-image refusal/quarantine control. Receipt: `build/mixed-library/acceptance.json`.
It must be rerun after current edits; the old receipt is historical.

Go evidence:
`../goSVM/results/compiler/2026-10-07-target-profiles-final/README.md`,
`metrics.json`, `qualification.json`, `bend-producer.manifest.json`.
Setup: `../goSVM/docs/TARGET_PROFILES.md`.
Go reports 54 cases per target across three runs, native cgo tests and nine
Go/Bend v0 cases across three runs including transaction rollback. Bend reviewed
the compact records, checked repetition stability, matched the producer manifest
byte-for-byte and checked 111 recorded Go source hashes. These were Go's runs,
not fresh Bend-side execution of Go tests.

That fixture qualifies Bend v1.53 plus Go v1.57 v0 locally on macOS arm64.
Go provides its own memory helpers; Rust supplies compiler_builtins. Do not
duplicate providers. Another root/artifact/compiler combination needs fresh
qualification. Go uses LiteSVM 0.8.2 for v0, LiteSVM 0.13.0 / Agave 4.0 /
SBPF 0.14.4 for modern v3, both with a documented rent-error precedence patch.
Runtime/feature differences prevent a matched performance claim.

Go supports explicit `fogo-v0` and modern `solana-v3` on v1.57, isolated outputs
and caches, and migration preserving historical v1.51 experimental-v3 projects.
Historical v3 is not modern v3. Go correctly refuses Bend's v0 bundle for v3.
Public-network validation remains pending.

## Bend solana-v3 library — accepted for Rust consumers (2026-10-09)

Changes since the reset checkpoint (hashes:
`build/director-handoff-2026-10-09/source-checkpoint-v3-accepted.json`):

- `compiler/target-profile.ts`: new `assertLibrarySections`; v3 objects with
  nonempty writable allocated sections are refused (the sbpfv3 Rust link script
  discards `.data`/`.bss`). Called from `compiler/library.ts`. v0 unchanged.
- `scripts/modern-library-runner/src/main.rs`: compiled and fixed. It builds
  LiteSVM after choosing the feature set (`LiteSVM::new()` fixes mainnet
  features, which refuse v3), checks 15 cases, records loader observations,
  the mainnet-feature load result, and per-run CU.
- `tests/target-profiles.ts` + `npm run test:target-profiles`: the acceptance
  orchestrator. Writes `build/target-profiles/<run>/acceptance.json` and never
  overwrites earlier runs.
- Docs: `docs/library-artifact-contract.md` (targets table, v3 link
  requirements, recorded acceptance, bundle hash), `tests/mixed-library/fixture.md`,
  `README.md`.

Key finding: the v3 linker does not refuse an unresolved import by default.
It emits an unrelocated `call -1`, and LiteSVM 0.13.0's v3 loader accepts the
image. Consumers must link with `-C link-arg=--no-undefined` and check the final
image has no imports/relocations. The orchestrator demonstrates both.

Results (logs and exits in `build/regression/20261009T182709Z/exits.tsv`):

| Command | Result |
| --- | --- |
| `npm run test:mixed-library` | pass, 15 v0 cases, max 473 CU (before and after final edits) |
| `npm test` | pass (26.6 min; Rust SBF 89 passed, 4 ignored) |
| `bun tests/program-client.ts`, `project-commands.ts`, `client-packaging.ts` | pass, in CI order |
| `npm run test:target-profiles` | pass, run `2026-10-09T18-54-30-949Z-d8c385d0`, 15 v3 cases x3, max 436 CU |

Published v3 bundle (artifacts byte-identical to the accepted run):
`build/interop/solana-v3/20261009T185443Z-f45b18ca/solana-v3/v1.57/library.manifest.json`,
SHA-256 `9db669cefeee15dfad19cb849671256303a40243129ab105f85beb81dd3c37ee`.
Same symbol/fingerprint as v0. The user relays it to GoSVM; Go must qualify
its own linked v3 image (with `--no-undefined` or equivalent import check).

Not established: network validation, Go v3 interop, hosts other than macOS
arm64, full-program/CLI/SHA v3. Host Rust used for the runner was 1.98.1
(documented CI version is 1.92.0). Nothing was committed or deployed.

## Later on 2026-10-09: fogo-v0 at v1.57, --json, GoSVM reply

User decisions: support Bend-native programs on both networks; one toolchain
(v1.57) for Fogo and Solana; all-enabled features for local Solana tests for now.
GoSVM has qualified the v3 bundle locally (Go+Bend, Go+Bend+Rust) and owns the
three-language example (`goSVM/tests/go-bend-rust`); do not duplicate it.

- Explicit `--target fogo-v0` now uses v1.57 (`compiler/target-profile.ts`);
  the historical three-argument command stays v1.53 (`legacyLibraryTarget`) for
  CI/`test:mixed-library`. `SBF_V157_TOOLS` (alias `SBF_V3_TOOLS`) selects v1.57.
- `scripts/build-library.ts --json` prints one result object on stdout.
- `tests/target-profiles.ts` adds the fogo-v0 v1.57 Rust link, v0 call-depth
  gate, execution under all-enabled and bundled-mainnet features, loader refusal
  of a wrong-interface v0 image, and the new tool refusals. The modern library
  runner accepts v0/v3 images and `--features all-enabled|mainnet`.
- Published fogo-v0 v1.57 bundle:
  `build/interop/fogo-v0/20261009T191953Z-0295b5f8/fogo-v0/v1.57/library.manifest.json`,
  SHA-256 `d84933502b7f2122c3c4339b3ace8e5fd5ae81b323c2449bff9b9f7f1ba66ecd`.
- Reply for the user to relay: `docs/coordination/2026-10-09-gosvm-reply.md`.
- Focused regressions passed (`build/regression/*-fogo157/exits.tsv`):
  `test:mixed-library`, `test:sha256-qualified-library`,
  `test:sha256-packed-qualified-library`, `test:target-profiles`
  (run `2026-10-09T19-21-39-347Z-aa7161d9`). Full `npm test` was not rerun after
  these library edits; it passed before them.

## Next: Bend-native full programs on both targets

Plan and de-risking results: `docs/targets-plan.md`. Proof of concept in
`build/v3-poc/` (trampolines `v3/sbpfv3_syscalls.c`, link script `v3/sbpfv3.ld`,
`v3/build.sh`): the vault and starter project link as clean SBPFv3 images, and
the starter's unchanged `test.ts` passes on v3 via the new
`scripts/test-runner-modern` (LiteSVM 0.13.0; `sdk/testing.ts`
`startTestProgram(elf, 'modern')`). Next is stage A: move the PoC into
`runtime/` and `scripts/build.ts` as a v3 program profile with a v3 final-image
gate (the v0 call-depth checker must not be relabelled), then stage B
(`bend.json` targets, runner selection), then stage C (fogo programs on v1.57,
re-baseline v0 evidence).

## Stage A (full-program SBPFv3) — done locally, 2026-10-09

See `docs/sbpf-v3-programs.md`. New: `scripts/build-v3.ts`, `runtime/sbpfv3_syscalls.c`,
`runtime/sbpfv3.ld`, `compiler/sbpf-v3-final-image.ts`, `scripts/test-runner-modern/`,
`tests-modern/` (shared Rust tests on LiteSVM 0.13.0), `tests/sbpf-v3-programs.ts`
(`npm run test:sbpf-v3`), `tests/sbpf-v3-final-image.ts`. Changed:
`scripts/program.ts` (`--target solana-v3`; v0 path unchanged), `sdk/testing.ts`
(runner selection), `tests/sbf.rs` + 8 modules (`crate::test_svm()`), root
`Cargo.toml` (`modern-litesvm` feature), two token-log assertions in
`tests/vault_sbf.rs` / `tests/exchange_sbf.rs` (count token `invoke [2]`).

Regression `build/regression/*-stage-a/exits.tsv`: `npm test` (89 Rust SBF passed,
4 ignored), the three client checks, `test:mixed-library`, `test:target-profiles`
and `test:sbpf-v3` passed. `test:sha256-qualified-program` first failed on a stale
runner pin: `scripts/test-runner/target/debug/bend-test-runner` was rebuilt on
Oct 6 from unchanged, committed sources (Cargo reports it up to date). At the
user's request the pin was re-recorded as `3cd6f111…` (previous `77df0dc1…`) in
`tests/sha256-qualified-program.ts`, `tests/sha256-short-sbf/prerequisite-hashes.json`
and both SHA docs; `test:sha256-qualified-program` and `test:sha256-short-sbf` then passed.

The machine was heavily loaded during this run (load 12–15, Spotlight
`corespotlightd` ~70% CPU): `npm test` took 64 min vs 27 min earlier; the last
20 `sqrt` Bend-reference cases (`tests/pure.ts`, `term_snf`) took ~36 min.

Next: Stage B (`bend.json` targets, CLI runner selection), Stage C (fogo programs
on v1.57), a deterministic v0/v3 CU benchmark, devnet deployment of a v3 program.

## Bend reference cache — 2026-10-09

`tests/bend-reference-cache.ts` (+ controls in `npm test`), used by `tests/pure.ts`;
see `docs/reference-cache.md`. Warm `npm test` 314 s vs ~27–64 min before; both
populate and warm runs passed (`build/regression/20261009T230828Z-reference-cache/exits.tsv`). Use
`BEND_REFERENCE_CACHE=verify` for records that must claim fresh interpreter evidence.

## Stage B (project targets) — opt-in implemented 2026-10-09 (unattended loop)

- `scripts/bend.ts`: optional `bend.json` `"targets": ["fogo","solana"]`
  (fogo -> v0/v1.53 unchanged; solana -> `buildProgram --target solana-v3`).
  Outputs `dist/<target>/program.*`; the client is checked byte-identical across
  targets and published once at `dist/program.client.*`. `test` runs each target
  on its runner (classic / `scripts/test-runner-modern`) with per-target reports.
  `--target fogo|solana` for build/test; `--local-rpc` needs one target. Missing
  v1.57 tools give an actionable error. No `targets` = previous behaviour exactly.
- `scripts/alpha-doctor.ts`: optional `solana-v1.57-{clang,ld.lld,llvm-readelf}`
  checks (version + content pin, host support) and modern-runner offline metadata.
  Doctor's required `cargo`/`rustc` checks already failed here before this work:
  host Rust is 1.98.1, the documented pin is 1.92.0.
- `tests/project-targets.ts` (`npm run test:project-targets`) passed: both
  targets build and test with no flags, shared client, per-target reports,
  `--target` selection, missing-toolchain, config and argument refusals.
  `tests/local-rpc.ts` (argument parsing) still passes.
- Docs: `docs/developer-workflow.md` (Fogo and Solana targets), `docs/targets-plan.md`.

Regression `build/regression/20261009T234909Z-stage-b/exits.tsv` (all exit 0):
`npm test` (8.6 min with warm reference cache; 89 Rust SBF passed, 4 ignored),
`program-client`, `project-commands`, `client-packaging` (CI order), then
`test:mixed-library`, `test:target-profiles`, `test:sbpf-v3`,
`test:project-targets`, `tests/local-rpc.ts`. The loop stopped for the decision below.

**Decision needed (user):** should `bend new` write `"targets": ["fogo","solana"]`
by default? Doing so changes the starter layout (`dist/<target>/…`) that
`alpha-acceptance`, `workflow-sbf`, `fresh-developer` acceptance, local-RPC tests
and their docs expect, and CI (Ubuntu, v1.53 only) cannot build the solana target.
Options: (a) keep `new` single-target (current); (b) default both and make CI /
acceptance pass `--target fogo` or set fogo-only; (c) default both only on hosts
with the v1.57 pins. Not changed pending the user's choice.

**Decided 2026-10-14 (user): option (b).** `createProject`/`bend new` writes
`"targets": ["fogo","solana"]` (`DEFAULT_TARGETS`); `new <dir> --target fogo|solana`
writes one. `alpha-acceptance`, `fresh-developer-acceptance`, `project-commands` and
`workflow-sbf` build and test the default starter with `--target fogo` (outputs
`dist/fogo/program.*`, shared client `dist/program.client.*`). The fresh-developer
report records `outputs.target`, which `fresh-developer-local` uses for `--target`
and the report path. `workflow-sbf` records each report's `stem`, which
`audit-developer-workflow` reads. Docs updated: the template README,
developer-workflow, external-alpha, tutorial, sbpf-v3-programs and targets-plan.
Two fixes to gates that were already broken by earlier uncommitted changes:
- `workflow-sbf`'s multi-account fixture now passes the primary address to
  `client.state.right`, which the primary-state binding in `sdk/multi-storage.ts`
  requires.
- `alpha-acceptance` now rebuilds and retests after restoring the law mutation,
  because builds now remove the previous ELF and manifest before starting.

Results in `build/regression/20261014T184128Z-default-targets/exits.tsv` (early
failed rows are kept):
- Passed: `project-commands`, `project-targets`, `workflow-sbf` (rerun),
  `fresh-developer-local`, `local-rpc`, `program-client`, `client-packaging`.
- Passed: `acceptance:alpha` with `RUSTUP_TOOLCHAIN=1.92.0-aarch64-apple-darwin`
  (`build/external-alpha/acceptance.json`, 2026-10-14T18:54Z). Host Rust 1.98.1
  fails doctor, which predates this work.
- `acceptance:developer` was blocked while required sources were untracked (it
  stages only git-tracked files). After the user-requested commits (`7f79e1f`…`eba20bd`,
  2026-10-14) it passed on the committed tree with Rust 1.92.0
  (`build/fresh-developer-acceptance/acceptance.json`, 132 s).

GoSVM's 2026-10-14 consumer-build request is answered in
`docs/coordination/2026-10-14-gosvm-reply.md` (probes under the session
scratchpad; no library code changed).

## Toolchain ergonomics follow-up — 2026-10-14 (user-requested)

- **Linux v1.57 pins and installer.** `compiler/target-profile.ts` `V157_HOSTS`
  pins each release archive and its `clang`/`ld.lld`/`llvm-readelf` for
  macOS arm64, Linux x86_64 and Linux aarch64. The archives were downloaded from
  the Anza v1.57 GitHub release; the macOS binaries match the earlier pins
  exactly. `npm run install:platform-tools [-- --root <dir>] [--archive <file>]`
  (`scripts/install-platform-tools.ts`) checks the archive hash before extraction
  and the binaries after, never overwrites a mismatched installation, and leaves
  no partial state. `bootstrap:alpha` runs it unless `SBF_V157_TOOLS` is set or
  `BEND_SKIP_PLATFORM_TOOLS=1`, and fetches the modern crates. Doctor and the
  missing-toolchain error name the installer. Controls: `tests/install-platform-tools.ts`.
  Both Linux pin sets were checked by installing from the real archives with the
  host override. The Linux binaries have not been *executed* here (no working
  Docker); CI (Ubuntu x86_64) is the first execution.
- **CI and acceptance build both targets with no flags.** CI installs v1.57 into
  `runner.temp` and runs `tests/install-platform-tools.ts`, `test:target-profiles`,
  `test:sbpf-v3` and `test:project-targets`. `alpha-acceptance`,
  `fresh-developer-acceptance` (report gains `outputs.solana`; local RPC still
  uses `outputs.target` = fogo), `project-commands` and `workflow-sbf` no longer
  pass `--target fogo`.
- **`rust-toolchain.toml` pins Rust 1.92.0**, so doctor passes without
  `RUSTUP_TOOLCHAIN`. `test-runner-modern` and `modern-library-runner` were
  checked to build on 1.92.0.
- **Path-independent library bundles.** Explicit `--target` library builds pass
  `-ffile-prefix-map=<output-dir>/=`, so `*.su` and the manifest hash do not
  depend on the output directory. Two builds per target into different
  directories gave identical trees. Objects, C and header are byte-identical to
  the published 2026-10-09 bundles, whose files are unchanged. The historical
  command is unchanged. The GoSVM reply was updated, and GoSVM was messaged
  directly.
- Disk cleanup (user-approved, 2026-10-14): `build/disk-cleanup/cleanup-2026-10-14.py`
  removes nested Cargo `target/`s and `.deps` copies inside old staging trees,
  root probe caches (`target/{sha256,mixed-library-cargo,modern-library-cargo,arithmetic-probe}`)
  and `build/` dirs no tracked file names. Files referenced by any text outside
  the candidates are kept. Plan and result: `build/disk-cleanup/run-2026-10-14-cleanup/`.
  `~/.cache/solana/v1.51` is removed too.
  Result: 12.7 GiB removed, 13,834 referenced files kept; repo 48 → 35 GB.
- Regression `build/regression/20261014T214935Z-toolchain-ergonomics/exits.tsv`,
  CI order: all 16 steps exited 0 (doctor without overrides; installer controls;
  both acceptance gates now building and testing fogo and solana with no flags;
  `npm test` 592 s with 89 Rust SBF tests passed and 4 ignored; mixed-library;
  client checks; target-profiles; sbpf-v3; project-targets; workflow-sbf).
- The Rust 1.92 rebuild changed the `scripts/test-runner` runner hash
  (`3cd6f111…` → `ed30e400bcd46a0cf5da08a64f9810eb6b6ba932257154ff4ce98a4c724ce1bc`,
  unchanged sources). It was re-recorded at the user's request in
  `tests/sha256-qualified-program.ts` and `tests/sha256-short-sbf/prerequisite-hashes.json`;
  both gates then passed.

## CI, local v3 deployment and Stage C — 2026-10-15 (user-requested)

- **First Linux CI runs.** Run `38662634003` (pushed `bc161ff`): installer with
  Linux pins matching, doctor, both acceptance gates (both targets) and the
  local deployment gates passed on Ubuntu. `npm test` then failed in
  `tests/generics.ts` (no `z3`), as it had on 2026-09-22. `48a5ba5` installs
  `z3-solver==5.1.0` into `.deps/refinement-venv` and exports `PYTHON`. Run
  `38739428855` passed that check and then failed in `tests/adapter-semantics.ts`:
  Ubuntu 22.04 clang 14 requires an opt-in flag for `-ftrivial-auto-var-init=zero`.
  The test now probes the host compiler and adds that flag only when needed.
  It is unverified on Linux until the next CI run.
- **Local SBPFv3 deployment.** `scripts/live-queue --program STEM` (default
  `build/queue`; refuses a stem whose client/interface differs) deployed the
  queue built with `--target solana-v3` to a local Agave 4.0.3 validator and
  passed the full live flow: `build/live-queue-1792069882706/report.json`.
  Solana CLI 3.0.15 (the user's install) refuses to parse the v3 ELF. Agave
  v4.0.3 (`solana-sbpf` 0.14.4, matching LiteSVM 0.13.0) was unpacked to
  `~/.cache/solana/agave-v4.0.3/` and used through `PATH` only. The SBPFv3
  feature is now `5cC3foj77…` (SIMD-0178/0189/0377); its feature account is
  activated on devnet, testnet and mainnet. Public clusters run Agave 4.3/4.4
  (`solana-sbpf` 0.23); whether our v3 ELF loads there is unverified. No devnet
  deployment was made (the user chose local).
- **Stage C: Fogo on v1.57.** `build:program --target fogo-v0` compiles with
  the v1.57 tools (content-pinned via `checkLibraryTools`) through the ordinary
  v0 pipeline (`compileSbf` gained an optional toolchain), keeping the v0
  import allowlist and call-depth gate; its manifest records `platformTools:
  v1.57`, `targetProfile: fogo-v0` and tool hashes. The `fogo` project target
  uses it. Untargeted builds, `npm test` fixtures and the qualified SHA paths
  stay v1.53. Doctor requires v1.57 (`sbf-v1.57-*`). `npm run test:fogo-v157`
  (new; in CI) builds the six applications plus the settlement probe on v1.57
  and runs their Rust tests on classic LiteSVM 0.7.1 from a staged directory:
  40 passed, 4 ignored (`build/fogo-v157/2026-10-15T13-17-22-743Z-0f5e6f37/acceptance.json`).
  ELF sizes are within 3% of v1.53. Max CU: vault 13,107 → 11,606, vesting
  13,075 → 13,075, exchange 22,574 → 22,568. GoSVM needs nothing: its `fogo`
  target is already v1.57, and it accepts v1.57 fogo-v0 bundles (it still
  marks that pairing untested until it qualifies ours).
- Regression `build/regression/20261015T133000Z-stage-c/exits.tsv`, CI order:
  all 11 steps exited 0 (doctor, installer controls, `npm test` 541 s with 89
  Rust SBF tests passed and 4 ignored, mixed-library, target-profiles,
  fogo-v157, sbpf-v3, project-targets, program-client, project-commands,
  client-packaging). Focused: `build/regression/20261015T132700Z-stage-c-focused/`
  (project-commands, workflow-sbf, target-profiles, acceptance:alpha, whose new
  staging built fogo with v1.57). `acceptance:developer` stages only tracked
  files, so it runs after commit (and in CI).

Hundreds of paths are dirty/untracked; ignored `build/` holds required
evidence. Do not reset, git-clean or broadly delete outputs/caches.
