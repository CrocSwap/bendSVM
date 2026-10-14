# SBPFv3 programs (`solana-v3`)

Bend-native programs can be built for Solana's SBPFv3 format:

```sh
npm run build:program -- examples/vault/PROOF.bend vault.process build/v3/vault --target solana-v3
```

The generated C, codecs, interfaces and clients are the same as for SBPFv0;
only the compile, link and final-image gate differ. Without `--target` the
command still builds SBPFv0 with platform-tools v1.53 exactly as before.
Projects created by `npm run bend -- new` list both `fogo` and `solana` targets
and select the build and test runner per target
([targets](developer-workflow.md#fogo-and-solana-targets)).

## Build profile

`scripts/build-v3.ts` uses platform-tools v1.57 (Clang/LLD 22.1.2), pinned by
content per host (`compiler/target-profile.ts` `V157_HOSTS`: `clang`, `ld.lld`,
`llvm-readelf` for macOS arm64, Linux x86_64 or Linux aarch64). `npm run install:platform-tools` installs
it after checking the archive and binary hashes; `SBF_V157_TOOLS` overrides the location.

- Compile with `-mcpu=v3`. The program, `runtime/memory.c` and
  `runtime/sbpfv3_syscalls.c` are separate objects.
- The shared runtime keeps its `extern sol_*` declarations, which are
  hash-pinned by the SHA qualification and unchanged. `runtime/sbpfv3_syscalls.c`
  defines each of them (and `abort`) as a call through its Murmur3-32 key, which
  Clang encodes as a static syscall (`call imm`, src 0). The cost is one extra
  guest call per syscall.
- Link with `runtime/sbpfv3.ld` (the v1.57 Rust `sbpfv3-solana-solana` layout:
  rodata at 0, bytecode at `0x100000000`, no `.data`/`.bss`/dynamic sections)
  and `--no-undefined`. Without it, LLD emits an unrelocated self-call for a
  missing symbol that the v3 loader accepts.
- Refuse writable allocated sections in any object or the image, any import,
  any relocation, frames over 4,096 bytes, and headers other than ET_DYN /
  EM_BPF / `e_flags` 3.

## Final-image gate

`compiler/sbpf-v3-final-image.ts` checks the exact ELF bytes. It is separate
from the SBPFv0 call-depth checker, which is not relabelled. It mirrors
solana-sbpf 0.14.4:

- the strict v3 ELF parser (identity, header sizes, program headers at
  `MM_RODATA_START`/`MM_BYTECODE_START`, entry inside bytecode);
- interpreter call semantics: `CALL_IMM` src 0 is a syscall looked up by key;
  src 1 is an internal call to `pc + imm + 1` that pushes one frame;
  `callx` is refused; JMP32 is allowed;
- the runtime limits from solana-program-runtime 4.0.0: 64 active frames
  including the entry, fixed 4,096-byte frames, no frame gaps.

It decodes from the entry, follows both outcomes of every branch, refuses
jumps or calls outside the bytecode or into the second slot of `lddw`, refuses
syscall keys other than the ten runtime syscalls, refuses recursion, and bounds
the longest call chain. Opcode validity is left to the loader's verifier at
deployment. The report, bound to the ELF and checker SHA-256, is written next
to the program and recorded in its manifest (`sbpfV3FinalImage`).

## Testing

- `scripts/test-runner-modern` is the project test runner on LiteSVM 0.13.0
  (same JSON protocol as `scripts/test-runner`); `sdk/testing.ts`
  `startTestProgram(elf, 'modern')` selects it. It loads SBPFv0 and SBPFv3.
- `tests-modern/` compiles the shared Rust tests (`tests/sbf.rs`) against
  LiteSVM 0.13.0 with v3-era Solana crates. `crate::test_svm()` builds the
  all-enabled configuration there and keeps `LiteSVM::new()` in the classic crate.
  `tests/external-layout-sbf.rs` is also a standalone target and still uses
  `LiteSVM::new()`, so its tests are v0-only on the modern crate.
- `npm run test:sbpf-v3` builds vault, vesting, exchange, AMM, batch, queue and
  the settlement probe as SBPFv3 into `build/sbpf-v3/<run>/`, runs the gate's
  negative controls, then runs those applications' Rust tests on the v3 ELFs
  and, for comparison, on the existing v0 ELFs under the same runtime.

With all features enabled, LiteSVM 0.13.0 replaces SPL Token with p-token,
which does not log instruction names. Two tests that counted
`Instruction: TransferChecked` log lines now count the token program's nested
invocations instead; they pass under both token implementations.

## Recorded results — 2026-10-09

Latest run `build/sbpf-v3/2026-10-09T20-56-48-023Z-4ada0ea2/acceptance.json`
(an earlier run, `…19-34-18-271Z-4917001f`, gave the same pass/fail results):

- All six applications and the settlement probe built, linked and passed the
  gate (5–6 active frames).
- 40 application tests passed on the SBPFv3 ELFs and 40 on the SBPFv0 ELFs
  under the same runtime (4 benchmark-only tests ignored in both).
- Gate controls (`build/sbpf-v3-final-image/2026-10-09T21-14-02-182Z-1b838be1/report.json`):
  12 mutation refusals, each for its expected reason. A synthetic 64-frame
  chain is accepted and runs (128 CU); a 65-frame chain is refused by the gate,
  and the runtime fails it with `exceeded max BPF to BPF call depth`.

**No CU comparison is claimed.** The tests' `*-metrics.json` files record a
maximum written by whichever parallel test finishes last; two identical runs
gave different values (vault SBPFv3 5,401 vs 11,401). A v0/v3 CU comparison
needs a deterministic per-operation benchmark on one runtime.

## Limits

- Local LiteSVM only; no devnet/mainnet deployment yet. The all-enabled
  feature set is a local choice, not observed cluster state.
- Recorded execution results are from macOS arm64. Linux pins match the release
  archives; CI (Ubuntu x86_64) runs these checks there.
- The qualified SHA program path and `build:library` without `--target` remain
  SBPFv0/v1.53.
