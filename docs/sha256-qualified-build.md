# Explicit qualified SHA SBF program build

The public opt-in command is:

```sh
npm run build:sha256-program -- PROOF.bend namespace.function build/program [storage-layout.json]
```

It derives qualification internally from the checked Bend source and its runtime
roots. A caller cannot authorize substitution with a hash, receipt, flag, or
chosen import list. The operation uses the same checked book for the proof and
subset gates, identity comparison, ordinary Backend emission, schema
generation, and replacement of exactly the reviewed internal SHA definition.
The returned original emission and its `taggedSumLowering` evidence remain
separately bound to the original C; generated codecs and storage use the
unchanged public schema.

The build invokes the fixed Anza platform-tools v1.53 Clang 20.1.7 / LLD
SBPFv0 profile. Its linked ELF must import both `abort` and `sol_sha256`, must
not import `sol_log_64_`, and must pass the emitted Clang stack-report bound of
4,096 bytes. Qualified stack rows must carry Clang's `static` marker; dynamic
or unknown markers fail closed. The ELF must also pass
`publishAcceptedFinalSbfArtifact`'s final-ELF call-depth gate.
The ordinary `build:program` and `build:library` paths retain their ordinary
import profile. Libraries use the separate opt-in
[qualified SHA library command](sha256-qualified-library.md), which selects an
SBF object and requires final linked image checks separately.

The final manifest binds the qualification receipt and its digest, all loaded
source and support inputs, the qualification JSON pins, the executing build
scripts, Bun/Bend and Anza tool hashes, generated artifact hashes, final ELF
hash, imports, stack report, and accepted call-depth receipt. The builder hashes
the ELF before and after its SBPFv0 header and import checks, then requires that
digest to match the generated-artifact snapshot, the final call-depth receipt,
and the manifest published by the callback. Inputs are rechecked before
publication. Prior successful ELF/manifest evidence is archived before
qualification starts; a later failure cannot leave it as the active success
output.

This byte binding assumes a trusted build process and a stable, non-hostile
filesystem while checks and publication run. It does not defend against a
concurrent writer that can replace and restore files between reads, or a
compromised compiler, linker, or `llvm-readelf`. Anza tool version banners are
checked; executable hashes are recorded for evidence but are not compared with
a reviewed digest allowlist. These hashes are evidence, not a capability or a
preservation theorem.

Qualification currently supports the pinned Bun 1.4.2 darwin-arm64 tuple only.
No Linux or other platform pin is claimed. Refreshing qualification pins is a
reviewed maintenance change.

## Focused acceptance

```sh
npm run test:sha256-qualified-emission
npm run test:sha256-qualified-program
```

The program gate builds a Bend wrapper whose transitive call reaches the pinned
SDK SHA reference, builds the same checked source through the ordinary path,
and executes both final ELFs in the prebuilt LiteSVM 0.7.1 runner. It compares
all lengths 0–55, high-valued bytes, poisoned inactive words, invalid active
bytes, and invalid lengths against Node crypto and the ordinary checked-source
ELF. It checks import-profile refusals and final ELF tampering. Its command-path
fault injection swaps the checked qualified ELF for an ordinary ELF lacking
both required imports immediately after profile validation; the build must
refuse, remove active output, and preserve the exact prior successful ELF and
manifest in this run's identified archive. A separate proof-gate failure also
checks run-bound archive hashes. The runner must already exist
at `scripts/test-runner/target/debug/bend-test-runner` (or be selected with
`SHA256_SHORT_SBF_RUNNER`) and match SHA-256
`3cd6f111c4db06be2f129c8b4fd93543e38b6d5e59d855d6e501745be6bdfe7a`
(re-recorded 2026-10-09 after a rebuild from unchanged runner sources; previously
`77df0dc19a4b496408bb185c3951b22e25efc90619a411ce6674a988c1298e83`); the gate
does not build Cargo or change shared dependencies.

The evidence is finite execution and mutation evidence. It does not establish
universal SHA equivalence, compiler/LLVM correctness, deployment behavior, or
production readiness. The SHA syscall and checked toolchain remain trusted
assumptions.
