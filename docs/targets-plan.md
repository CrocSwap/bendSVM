# Fogo/Solana targets for Bend-native programs — plan (2026-10-09)

Goal: a Bend project builds, tests and deploys for Fogo and Solana with the
user naming networks, not ISAs, toolchains or runners. Mixed Go/Bend/Rust
programs keep GoSVM as the host shell; Bend supplies verified library bundles.

## Network facts this plan depends on

From GoSVM's live-cluster reading (2026-10-09, not independently rechecked
here): the SBPFv3 deploy gate is active on Solana mainnet, devnet and testnet,
and SIMD-0500 disables new SBPFv0–v2 deployments. Fogo testnet and mainnet
accept SBPFv0 only. Therefore `fogo` → SBPFv0 and `solana` → SBPFv3.
LiteSVM 0.13.0's bundled "mainnet" feature list predates the v3 gate and
refuses v3; it must not be used as evidence of network state.

## De-risking results (this session, build/v3-poc/)

- v1.57 clang lowers a call through a constant Murmur3 hash to a static
  syscall (`call imm`, src 0). Hashes for the nine runtime syscalls plus
  `abort` were computed; `sol_set_return_data`, `abort`, `sol_log_` match
  published constants.
- The v0 runtime's `extern sol_*` calls are left unchanged. A separate v3-only
  translation unit defines each symbol as a static-syscall trampoline, so v0
  runtime files (hash-pinned by the SHA qualification) stay byte-identical.
- With a v3 link script (rodata at 0, text at 0x100000000, no .data/.bss/
  dynamic sections) and `ld.lld --no-undefined`, the vault and the starter
  project link to ET_DYN, flags 3, no imports, no relocations, no writable sections.
- `scripts/test-runner-modern` (LiteSVM 0.13.0, same JSON protocol, all-enabled
  features) runs the starter's unchanged `test.ts` on both the v0 and v3 ELFs:
  8 transactions, 16 assertions, max 101,600 / 101,588 CU. LiteSVM 0.7.1
  refuses the v3 ELF (`InvalidAccountData`).

## Work items

1. **Program target profile.** Generalize `compileSbf` with a target profile
   (shared with `compiler/target-profile.ts`): v3 flags, `runtime/sbpfv3_syscalls.c`,
   `runtime/sbpfv3.ld`, `--no-undefined`, final-image checks (header, zero
   imports/relocations, no writable sections, frames ≤ 4096). v0 output stays
   byte-identical.
2. **v3 final-image gate.** The v0 call-depth checker decodes v0 only. Add a
   v3 decoder/CFG (static syscalls, internal calls, v3 instruction classes)
   with its own refusal controls; never relabel the v0 gate.
3. **Project targets.** *Implemented 2026-10-09 (see developer-workflow.md). Since
   2026-10-14 `bend new` writes both targets (user decision, option b), v1.57 is
   pinned for macOS arm64 and Linux x86_64/aarch64 with `npm run install:platform-tools`,
   and CI and the acceptance gates build and test both targets with no flags.* `bend.json` gains `"targets": ["fogo", "solana"]`
   (default both). `bend build` writes `dist/fogo/program.so` and
   `dist/solana/program.so` with per-target manifests; `bend test` runs each on
   the right runner; `doctor`/`bootstrap` install/check the needed tools.
   Existing single-output projects keep working.
4. **Runner and local RPC.** Modern runner in the test SDK and CLI; local
   RPC/devnet deploy reads the cluster's v3 gate before deploying (as GoSVM does).
5. **Examples and regression.** All six applications build and pass their
   tests for both targets; CU comparison table v0 vs v3; `npm test` and
   CI-ordered client checks unchanged for v0.
6. **GoSVM requests.** Stable `build:library --json` entry, v3 link
   assumptions, fogo-v0 pin decision (below).

## Decisions (user, 2026-10-09)

- Fogo uses v1.57 too (one install). Staged: A) add the v3 program profile beside
  the unchanged v1.53 v0 profile; B) project targets/runners; C) move fogo to
  v1.57 and re-baseline v0 evidence. Qualified SHA paths stay v1.53 until re-qualified.
- Local Solana tests use all-enabled features for now; a pinned live-cluster list later.
- 2026-10-14: `bend new` defaults to `"targets": ["fogo", "solana"]`. With the Linux
  v1.57 pins and installer, CI and acceptance build and test both targets.
- 2026-10-15 (Stage C, implemented): the `fogo` project target builds with
  `build:program --target fogo-v0` on v1.57 (ordinary SBPFv0 import checks and
  call-depth gate, classic LiteSVM 0.7.1). The untargeted command, `npm test`
  fixtures and the qualified SHA paths stay v1.53 until re-qualified.
  `npm run test:fogo-v157` re-baselines the six applications on v1.57 v0 ELFs
  (40 passed, 4 ignored; `build/fogo-v157/<run>/acceptance.json`, which also
  records ELF sizes and CU against v1.53). Doctor now requires v1.57.

## Options that were presented

- **Toolchain for Fogo.** Recommended: one install (v1.57) for both targets,
  with v1.53 kept only for the already-qualified SHA paths until re-qualified.
  Cost: every v0 program's bytes and CU numbers change and need fresh evidence.
- **Feature set for local Solana tests.** All-enabled (current) vs a pinned
  feature list read from a live cluster (closer to reality, needs an RPC read).

Acceptance for the milestone: a fresh project's `new → check → verify → build
→ test` passes for both targets with no target-specific flags; examples pass on
both; v3 gate refusal controls pass; v0 regression unchanged; docs updated.
