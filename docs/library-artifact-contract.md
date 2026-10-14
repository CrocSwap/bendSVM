# Bend library artifact contract v1

This is the ordinary `build:library` interchange contract for GoSVM and Rust
consumers. The [ABI v1 fixture](../tests/mixed-library/fixture.md) governs the
call signature, canonical bytes, status codes and pointer preconditions.
Target metadata does not change that ABI or its root/schema fingerprint.

## Available targets

The producer supports two explicit profiles, both built with Anza platform-tools
v1.57 (one install, the same backend GoSVM uses). ABI v1, the symbol and the
schema fingerprint are identical across them; the objects differ.

| Manifest field | `fogo-v0` | `solana-v3` |
| --- | --- | --- |
| `version` | `1` | `1` |
| `kind` | `"bend-library-v1"` | `"bend-library-v1"` |
| `targetProfile` | `"fogo-v0"` | `"solana-v3"` |
| `abiVersion` | `1` | `1` |
| `toolchains.anzaClang.platformTools` | `"v1.57"` (LLVM 22.1.2) | `"v1.57"` (LLVM 22.1.2) |
| `toolchains.anzaClang.cpu` | `"generic"` | `"v3"` |
| `toolchains.anzaClang.sbpfVersion` | `0` | `3` |
| SBF object machine / `e_flags` | 263 / 0 | 247 / 3 |
| `finalElfAuthorized` | `false` | `false` |

Both selected SBF objects are ELF64, little-endian and relocatable (`e_type=1`)
with the profile's machine and flags; the producer checks these headers before
publishing the manifest. Compiler executable hashes/version text are recorded
under `toolchains.anzaClang`; the inspector is recorded under
`toolchains.anzaReadelf`.

`fogo-v0` names a build compatibility profile. It does not establish a completed
Fogo deployment or runtime acceptance. SBPFv0 is also usable on other runtimes
that accept it. RPC endpoints and program IDs are consumer deployment settings.

The **historical three-argument command** (no `--target`) still builds
`fogo-v0` with platform-tools v1.53 on any host, selected by `SBF_TOOLS`; CI
and `test:mixed-library` use it. Its manifest also says `targetProfile:
"fogo-v0"`; consumers distinguish it by `toolchains.anzaClang.platformTools`.
The earlier GoSVM pin `ec18012f…6bc6de` is such a v1.53 bundle.

Explicit targets are pinned to platform-tools v1.57 on **macOS arm64 only**.
`SBF_V157_TOOLS` (alias `SBF_V3_TOOLS`) overrides the default
`~/.cache/solana/v1.57/platform-tools/llvm/bin`; the producer refuses other hosts, other version text and any `clang` or
`llvm-readelf` whose content differs from the recorded SHA-256 pins in
`compiler/target-profile.ts`. It also refuses SBF objects with nonempty
writable allocated sections, because the sbpfv3 Rust link script discards
`.data` and `.bss`. Other host packages need their own pins and qualification.
Do not relabel a v0 object or reuse a historical experimental v3 object.
Full-program, project CLI and qualified SHA builds remain v0 only.

Explicit `--target` builds write to `<stem-dir>/<profile>/<platform-tools>/<stem-basename>`;
the historical three-argument command keeps its v0 paths. A stem holding
another profile's manifest is refused.

### solana-v3 linked-image requirements

The SBPFv3 linker does **not** refuse an unresolved import by default: it
emits an image whose call to the missing symbol is an unrelocated `call -1`,
and LiteSVM 0.13.0's v3 loader accepts that image. Interface refusal therefore
belongs to the final link. A Rust consumer must:

1. Link with the v1.57 Rust toolchain (`rustc 1.95.0-dev`, LLVM 22.1.2), target
   `sbpfv3-solana-solana`, `-C target-cpu=v3` and `-C link-arg=--no-undefined`.
2. Check the final image is ET_DYN, machine 247, `e_flags=3`, with no undefined
   symbols, no relocations, no writable allocated sections and the expected
   root/schema-specific symbol.
3. Use static syscalls (the target's `+static-syscalls` feature);
   `tests/mixed-library/program.rs` shows `sol_set_return_data` by its
   Murmur3 hash `0xa226d3eb`, with the binding selected by `BEND_LIBRARY_BINDINGS`.

A `fogo-v0` v1.57 Rust consumer links with target `sbpf-solana-solana`,
`-C target-cpu=generic`. Imports stay dynamic in v0, so wrong-interface
refusal comes from the loader ("Unknown symbol"), not the linker; the final
image should also pass the project's v0 call-depth gate.

`npm run test:target-profiles` exercises these checks and the producer
refusals in a fresh `build/target-profiles/<run>/` directory.

### Consumer-invoked builds (`--json`)

```sh
npm exec -- bun scripts/build-library.ts <PROOF.bend> <namespace.function> <stem> --target fogo-v0|solana-v3 --json
```

Run from the bendSVM root. With `--json`, stdout holds exactly one JSON object
and progress goes to stderr. Exit 0 prints `{ok: true, manifest, manifestSha256,
targetProfile, platformTools, root, symbol, schemaFingerprint}`, where `manifest`
is the absolute path `<stem-dir>/<profile>/v1.57/<stem-name>.manifest.json`.
A non-zero exit prints `{ok: false, error}` and publishes no manifest. Pin
`manifestSha256` in the consumer lock and verify the artifacts as below.

### Recorded acceptance — 2026-10-09

The first `solana-v3` run passed (`build/target-profiles/2026-10-09T18-54-30-949Z-d8c385d0/acceptance.json`):
isolated v0/v3 outputs with one ABI symbol; refusals for unknown/missing profiles,
v1.53 tools, a content-mismatched clang, a cross-profile stem, wrong headers and
writable sections; the native harness on the v3 host object; a v1.57 Rust link
with no imports or relocations; refusal of wrong-interface and missing-object
links; and 15 Rust/Bend cases in simulation and submission across three runs on
unpatched LiteSVM 0.13.0 / agave-feature-set 4.0.0 (max 436 CU). Expected
reports come from an independent reference of `fixture.md`, cross-checked with
`tests/mixed-library-sbf.rs`; a tampered expectation makes the runner fail.
Two runs produced identical object and final-ELF hashes.

The runtime used LiteSVM's all-enabled feature set as a local test choice.
LiteSVM's mainnet feature configuration refused the v3 ELF (SBPF version not
enabled) and loads v0. This is not network validation, and it qualifies the
Rust consumer only: a Go v3 caller needs its own linked-image qualification.

After `fogo-v0` moved to v1.57, run `build/target-profiles/2026-10-09T19-19-34-887Z-980bd33c`
also passed the `fogo-v0` checks: v1.57 Rust link (`sbpf-solana-solana`), v0
call-depth gate accepted, 15 cases x3 under both all-enabled and LiteSVM's
bundled mainnet features (max 432 CU), and loader refusal of the
wrong-interface image on both. Explicit fogo-v0 with v1.53 tools or a
content-mismatched clang, and the historical command with v1.57 tools, are refused.

Published bundles for consumers (objects, headers, bindings and sources
identical to the accepted runs):

| Profile | Manifest | SHA-256 |
| --- | --- | --- |
| `solana-v3` | `build/interop/solana-v3/20261009T185443Z-f45b18ca/solana-v3/v1.57/library.manifest.json` | `9db669cefeee15dfad19cb849671256303a40243129ab105f85beb81dd3c37ee` |
| `fogo-v0` (v1.57) | `build/interop/fogo-v0/20261009T191953Z-0295b5f8/fogo-v0/v1.57/library.manifest.json` | `d84933502b7f2122c3c4339b3ace8e5fd5ae81b323c2449bff9b9f7f1ba66ecd` |

## Build and select artifacts

Run from the bendSVM root, using a fresh output directory:

```sh
npm run build:library -- tests/mixed-library/PROOF.bend mixed.evaluate build/interop/fogo-v0/my-build/library
```

Only a successful command establishes a completed build. It writes
`library.manifest.json` last. The ordinary command does not provide the locked,
immutable-generation publication lifecycle of the qualified SHA commands;
do not use an old manifest remaining after a failed rebuild as success.
Retain the manifest and its selected artifacts together, and pin the manifest
SHA-256 in the consumer's dependency lock.

Paths in `selection` are basenames relative to the manifest directory:

| Selection field | Purpose |
| --- | --- |
| `sbfObject` | Canonical ABI wrapper and pure checked Bend implementation |
| `memoryObject` | Optional SBF memory helper definitions |
| `hostObject` | Same ABI/ordinary implementation for native linking and cgo tests |
| `header` | Generated C declaration, fingerprint, byte sizes and status constants |
| `bindings` | Generated Rust binding |
| `schema` | Root and canonical type information for generated Go bindings/codecs |
| `hostSource`, `sbfSource` | Generated ordinary C implementation |

Every selected basename has an `artifacts[basename]` record containing `bytes`
and the lowercase, full SHA-256 of the file. The basename follows the requested
output stem; consumers must use `selection`, not assume the name `library`.
The build also records checked source/dependency hashes under `inputs` and
`dependencies`; those source paths are provenance, not package-relative files
that a consumer must load.

## Consumer checks

Before native or SBF linking, the consumer must:

1. Check the pinned manifest bytes, contract kind/version and ABI version.
   Refuse missing/unknown target profiles. Historical manifests without the
   explicit profile/selection fields require rebuilding for this contract.
2. Check the expected `root`, `symbol`, `schemaFingerprint`,
   `canonicalInputBytes` and `canonicalOutputBytes`. The selected schema must
   agree on ABI version, root, symbol, fingerprint and byte sizes. Use the
   schema/header to generate matching Go bindings; do not reinterpret C struct
   layouts as the canonical wire contract.
3. Resolve selected basenames within the package, require their hash records,
   and verify actual file sizes and hashes. Recheck the object bytes used for
   linking or copy them into an immutable, verified consumer build directory.
4. Check that the requested SBF profile matches `targetProfile` and that both
   SBF headers match the recorded version. Check the recorded platform-tools
   pin against the consumer's explicit allowed library pins. A shared `v0`
   label alone does not approve arbitrary compiler combinations.
5. Link exactly one provider of each memory helper. A Rust SBF image already
   supplies standard memory helpers through `compiler_builtins`; do not also
   link `memoryObject` there. A Go/C shell can use that object if its final link
   needs those helpers and has no other provider.

Explicit Bend library targets use v1.57; the historical command uses v1.53.
A GoSVM compiler upgrade does not silently upgrade either pin. If the caller uses another pin, require explicit
qualification of that mixed final image before treating it as supported.

The GoSVM [2026-10-07 local qualification](../../goSVM/results/compiler/2026-10-07-target-profiles-final/README.md)
consumed the published `mixed.evaluate` bundle unchanged: Bend v1.53
`fogo-v0` objects linked into a Go v1.57 `fogo-v0` caller. Native cgo checks
and nine linked-image scenarios passed across three SBF runs on macOS arm64,
including malformed canonical input and transaction rollback. The copied
producer manifest SHA-256 is
`ec18012f5bb98cd19813b721f2ec343d628c679052828a3eb122ca1b335bc6de`.
This qualifies that fixture and compiler combination locally; another root,
artifact, host or compiler combination needs its own qualification. The SBF
runner used LiteSVM 0.8.2 with a documented rent-error precedence patch.
Public-network validation remains pending. A Bend `solana-v3` producer now
exists (above); Go has not yet qualified a v3 image linking it.

For native cgo tests, select `hostObject` and `header`, with the host's normal
linker/runtime. The native object must match the actual host architecture and
object format. The object is not portable across hosts and the SBF memory
object is not a native dependency. The ABI retains no passed pointer; callers
must still meet the fixture's accessibility, alignment and alias rules and
cgo's pointer rules.

`finalElfAuthorized=false` is intentional: this manifest describes library
objects. Final link, imports, entrypoint, stack/call-depth limits, transaction
behavior and target runtime acceptance remain consumer checks. Native cgo
tests alone do not establish SBF execution or transaction rollback.

This contract does not select a qualified SHA replacement. Those packages
use a different active/generation manifest and additional final-image gates;
consult [qualified SHA libraries](sha256-qualified-library.md) before adding
support for them. Never select a private ordinary comparison manifest as a
substitute for a qualified package's active selection.
