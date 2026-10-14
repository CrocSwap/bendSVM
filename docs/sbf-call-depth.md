# Final SBFv0 call-depth checker

`compiler/sbf-call-depth.ts` exports `checkSbfCallDepth(elfBytes)`. It analyzes
the exact final ELF byte array and returns a report bound to its SHA-256. The
report includes the parsed target, pinned loader/runtime assumptions, reachable
guest-call and syscall edges, the longest bounded frame path, and refusal
diagnostics. `status === "accepted"` means a bound was established under the
assumptions below; `status === "refused"` means no bound was established.

The checker starts at `e_entry`, requires one executable `.text` section, and
decodes instructions from the ELF bytes. Symbol sizes and apparent function
ranges do not limit control-flow traversal. Instruction indices are relative to
`.text`; the root is the entry instruction.

## Pinned loader and runtime model

The supported target is ELF64 little-endian `ET_DYN`, `EM_BPF` or `EM_SBPF`,
with `e_flags == 0` (SBPFv0), as produced for this project's pinned target. The
report records the loader settings it assumes: a 64-bit host (`usize` is eight
bytes), `reject_broken_elfs=false`, and
`enable_symbol_and_section_labels=false`. The call-frame limit follows
`solana-sbpf` 0.11.1 and `solana-program-runtime` 2.3.13: entry occupies one of
64 active guest frames,
leaving at most 63 nested guest calls. The checker accepts 64 active frames and
refuses a possible 65th. This is separate from CPI instruction-stack depth.
The pinned stack-frame size is 4,096 bytes. The checker also caps `.text` at
65,536 instructions and refuses more than 1,000,000 activation/instruction
analysis states.

The checked execution model is LiteSVM 0.7.1's interpreter. JIT behavior is
assumed to match the interpreter and was not exercised in this validation. The
report treats syscalls as adding no guest frame and checks import hashes against
guest-function keys; the syscall registry itself is external. CPI and nested
program call depth are outside this checker.

SBFv0 direct `CALL_IMM` instructions without a dynamic relocation encode a
`.text`-relative displacement. The loader registers each target using the
Murmur3 key of the target PC's native `usize` bytes and replaces the immediate
with that key. For relocation type `R_BPF_64_32` (ELF type 10), the loader reads
the referenced symbol's raw name bytes. An undefined import is keyed by those
bytes; a defined function is keyed by its target PC, except for the literal name
`entrypoint`, which is remapped to `e_entry` after relocations. The 64-byte
NUL-terminated name limit applies only to symbols used by `R_BPF_64_32`; unused
dynamic symbol names are not needed for the call bound. Defined functions in
`.text` count as guest calls, including local `memcpy`/`memset` wrappers.

The interpreter checks the syscall registry before the guest-function registry,
so an import whose Murmur3 key collides with a registered guest-function key is
refused. The checker conservatively includes function-PC keys from available
symbol tables when checking imports, even if it cannot prove each one is
registered by a reachable relocation; this can reject some safe ELFs. The
report's syscall edges assume zero guest frames. The literal raw import name
`abort`, after loader resolution and collision checks, additionally assumes the
pinned Solana runtime's abort builtin halts execution. Other imports are
conservatively treated as returning, and their implementation remains external.
Each edge records `returnsToGuest`; the report and artifact receipt record the
exact `terminalSyscalls` assumption. Missing, changed or additional assumption
fields reject during receipt verification. This is a runtime contract assumption,
not a proof of the builtin or JIT.

Only the exact raw bytes `abort` select this rule. A defined guest function named
`abort`, an unresolved call, or an import whose decoded label hides different
bytes (such as a UTF-8 BOM) does not become terminal. Caller continuations remain
reachable if any callee branch returns; recursive alternatives remain refused.

The loader tries the first `PT_DYNAMIC` header first. Its `Elf64Dyn` slice needs
an in-range file slice, a size divisible by 16, and an 8-byte-aligned file
offset. If that slice is invalid, the loader tries the first `SHT_DYNAMIC`
section. A valid section slice becomes the dynamic table; an invalid section
slice rejects the ELF. If no such section exists, the loader treats the ELF as
static and applies no dynamic relocations. The checker refuses an invalid first
`PT_DYNAMIC` rather than following either fallback. When there is no
`PT_DYNAMIC`, it supports an aligned `SHT_DYNAMIC` section and refuses an
unaligned one. This prevents the checker from applying relocations that the
loader would ignore or reading a different fallback table.

The checker follows the pinned loader's ELF lookup order:

- `DT_REL`: the first program header of any type whose `p_memsz` range contains
  the `DT_REL` address wins. The loader translates through that header's
  `p_offset` and reads `DT_RELSZ` bytes, even if `p_filesz` does not cover them.
  If no program header contains the address, the first section of any type with
  matching `sh_addr` supplies `sh_offset`. The checker models that selection,
  then refuses unless the selected bytes are exactly one parseable `SHT_REL`
  section it can analyze.
- `DT_SYMTAB`: the first section of any type at the tagged address wins. A
  selected type other than `SHT_SYMTAB` or `SHT_DYNSYM` is refused, as the
  loader rejects it. The checker decodes that first section.
- Dynamic relocation names: the loader looks up the literal `.dynstr` section
  name, independently of `DT_SYMTAB.sh_link`. Its section parser rejects
  duplicate `.dynstr` names (and duplicate `.symtab` or `.strtab` names), so an
  accepted ELF has at most one literal `.dynstr`. The checker follows that rule
  and applies the pinned 64-byte string-lookup limit only to symbols referenced
  by `R_BPF_64_32`. Dynamic symbol names are raw bytes for loader keys; the report
  decodes them only for readable edge labels.
- Entrypoint: after relocations, the loader removes the `entrypoint` key and
  registers that key at `e_entry`. A defined dynamic function named
  `entrypoint` therefore calls `e_entry`, regardless of its valid `.text`
  `st_value`. The checker maps that call to the root. If a numeric relative-call
  target has the same key but a different PC, the checker refuses because the
  loader's entrypoint registration would redirect it. Other defined dynamic
  functions use their target-PC key; their names do not create additional keys.
  No such collision exists in the checker's current 65,536-PC range. An
  exhaustive scan of that range also found no duplicate numeric-PC keys.

All pinned-loader relocation write ranges are checked. `R_BPF_64_64` writes
four bytes at `r_offset+4` and `r_offset+12`; `R_BPF_64_RELATIVE` writes those
immediates for a text `lddw` pair and writes eight bytes at `r_offset` outside
text; `R_BPF_64_32` writes four bytes at `r_offset+4`. Pinned SBPFv0 disables
`enable_elf_vaddr`, so the loader consumes `r_offset` as an ELF byte offset;
the checker compares writes with `.text`'s file range for this target. A write
from outside `.text` that reaches text is refused. An in-text address
relocation is accepted only for a recognized `lddw` pair, and a call relocation
only for a `CALL_IMM` slot.

Conditional branches explore both outcomes. Unconditional jumps and ordinary
fallthrough cross apparent symbol boundaries. `lddw` continuation slots cannot
be branch or call targets. A call's continuation is reachable only when the
callee has a reachable `EXIT`; syscalls may return except the resolved literal
`abort` import under its explicit pinned-runtime contract. Loops do not accumulate
frames, while cycles in the reachable direct-call graph are refused as
recursion. Reachable `callx` (`CALL_REG`) is refused because its target cannot
be bounded statically. Unreachable `callx` instructions do not taint the root
result; the mixed Rust/Bend fixture has eight unreachable `callx` instructions.

## Candidate gate assumptions and limits

An accepted report is a conservative frame-depth bound for one exact ELF under
the stated SBFv0 loader/runtime convention. It assumes the pinned loader,
syscall registry, entrypoint convention, 64-bit host, interpreter behavior,
`reject_broken_elfs=false` execution setting, and 64-frame runtime setting; it
assumes JIT and interpreter call behavior match. It does not establish behavior
under a different SBPF/Agave release or runtime configuration. CPI and nested
program execution are not analyzed. This checker is not an ELF loader, general
SBF verifier, instruction-validity proof, stack-byte bound, compute-unit bound,
CPI analysis, or compiler-correctness result. The compiler, checker
implementation, LLVM, adapter/runtime, and external programs remain trust
assumptions.

The checker supports final `ET_DYN` files with ordinary ELF section and symbol
tables and the pinned loader's `REL` relocations. It refuses `ET_REL` libraries,
reachable indirect calls, recursion, unrecognized control flow, unsupported
dynamic layouts, and malformed metadata. Branches are explored without
register-value reasoning, so mutually exclusive paths can increase the bound
or appear recursive. Passing the focused fixtures does not establish overall
soundness; independent acceptance of this correction remains pending.

## Focused regression and loader evidence

Run the focused tests with the repository-pinned Bun:

```sh
bun test ./tests/sbf-call-depth.ts
npm run test:sbf-call-depth-runtime
```

The runtime regression also runs in `npm test`. Eight offline SBF executions
cover abort, return and conditional guest-helper paths. A genuine System transfer
selects each conditional branch. Failed transactions preserve the watched
account balance, owner, executable flag and bytes; the testing SDK snapshot
does not include rent epoch. These cases exercise the pinned interpreter and
exact terminal-syscall receipt profile, without proving general runtime
correctness or application lifecycle behavior.

The tests compare generated synthetic ELFs with small committed loader-probe
assets under `tests/sbf-call-depth-fixtures/`. Two frozen final programs are
also committed there, so a fresh checkout does not depend on ignored `build/`
state. The codec ELF hash is
`350711998b62f79e866236f2360614f41c5cc7c197c0c2d740fa25cd3876bfaf`; the frozen
mixed Rust/Bend ELF hash is
`0aed619c33223d7f3e816b5e800a340fe9107a023e47216ae4a4dc52a0c4aadc`.

The codec ELF is a historical frozen-byte fixture. The host's
`docs/large-codec-stack.md` and DCG reports record the private staged inputs and
frame-size evidence, but no build receipt was found that records this exact ELF
hash. Those records do not establish byte reproducibility for the fixture. The
mixed ELF hash matches the artifact recorded by the host's
`build/mixed-library/acceptance.json` receipt, reproduced by
`RUSTUP_TOOLCHAIN=1.92.0 npm run test:mixed-library`; the matching evidence is
`build/overnight/mixed-current-build-evidence.json` (SHA-256
`fc174aedb42b0ca625c5a8c113732728b2f104d1bc2e41de1adbcca21505ad7c`). It
records the acceptance receipt SHA-256
`517377b573887e0703d06a3dee267c328ff9341218b8cdb811ac45a502f5a65f`, which
records the exact mixed ELF hash and 13,656-byte length. The replay evidence
reports all recorded input hashes match and records the command and toolchain;
it does not record a repository commit. The DCG main-gate receipt records report
SHA-256 `c0ab4acad9bf00ab7614e54f4c72908125296726631fef79b78ae28659131a98` and
the 2,304-byte frame result, but no matching ELF digest. The mixed receipt ties
its artifact to recorded source and tool hashes without promising that a later
build will produce identical bytes.

The previous checker from `98e56f4` was run against the same synthetic bytes.
It returned finite bounds for cases where the corrected checker now refuses or
finds recursion:

| Case | Previous report | Corrected report | Pinned runner result |
| --- | --- | --- | --- |
| Relocated defined function named `entrypoint` at a PC other than `e_entry` | 2 frames | recursive call refused | Loaded; invocation reached the 64-frame BPF call-depth limit |
| `PT_NOTE` first matches `DT_REL` by `p_memsz`; later `PT_LOAD` points at another table | 1 frame (syscall) | loader/section byte mismatch refused | Loaded; invocation succeeded in 3 CU using the first table |
| First exact-address section for `DT_REL` is `.dynstr`, not `.rel.dyn` | 1 frame (syscall) | loader/section byte mismatch refused | Loaded; invocation succeeded in 3 CU using the first section |
| First `DT_SYMTAB` address match is an invalid `SHT_STRTAB` | 1 frame | loader symbol-table mismatch refused | Loader rejected with `Instruction(InvalidAccountData)` |
| Linked string table says `helper`; literal `.dynstr` says `entrypoint` | 2 frames | recursive call refused | Loaded; invocation reached the 64-frame BPF call-depth limit |
| `R_BPF_64_64` outside text writes its high immediate into the first text instruction | 1 frame (`EXIT`) | text-overlapping relocation refused | Loaded; invocation followed the relocated branch and succeeded in 4 CU |
| `PT_DYNAMIC` file offset is 4 mod 8, with no `SHT_DYNAMIC` fallback | 1 frame (`sol_log_`) | `PT_DYNAMIC` fallback refused | Loaded; invocation exceeded the 64-frame BPF call-depth limit |

The aligned `.so` controls cover `SHT_DYNAMIC` without a program header and a
`PT_DYNAMIC`-only table. Both load and invoke successfully in 102 CU. Another
test keeps an aligned `SHT_DYNAMIC` while the first `PT_DYNAMIC` is unaligned;
the checker refuses it even though the loader can fall back to the section.
Before this change, the dispatch-base checker at `6e67e85` accepted the
unaligned fixture at one frame with a `sol_log_` edge. The corrected checker
refuses the same bytes with `unsupported_dynamic_table_fallback`; the pinned
runner loads them and then reports `exceeded max BPF to BPF call depth`.

The same deterministic relocation tests cover the other two write forms. For
`R_BPF_64_RELATIVE` at `r_offset = .text - 4`, the previous checker reported
one frame (`EXIT`), while the corrected checker refuses the 8-byte write that
overlaps text. For `R_BPF_64_32` at that address, the previous checker already
refused because the relocation target was outside `.text`; the corrected
checker also refuses, now based on its four-byte write range. These two exact
fixtures were not sent through LiteSVM; the refusal follows the pinned loader's
relocation write implementation and is conservative.

The exact probe assets and SHA-256 values are:

| Fixture | SHA-256 |
| --- | --- |
| `entrypoint-remap.so` | `abbee6faa387b1a108765f3911ff0c3a9192feeb365415a3e2a04b63faf7c780` |
| `dt-rel-phdr-first.so` | `54668f296f985247eb12b3a3764939e8c27c86fa36bdc95095bfc5809b6fc01f` |
| `dt-rel-section-first.so` | `fdec441c357ecce1c51b4d58dd6348a43b0bd717f4e4fc3818b737e3947fb36a` |
| `dt-symtab-first-invalid.so` | `9c489cfae29418751b95decdc535093d3cb23fe665dcb91010f37b84cd1cbeb2` |
| `dynstr-literal-entrypoint.so` | `2fcb44356cd160184c27de8eb6c7496659dc12772eebbf7a262b46716174f79e` |
| `relocation-write-overlap.so` | `0fc150d2d693aa13e7d567202043ee2ebd540cc63afeb405ffe9c9c13be11b3f` |
| `sht-dynamic-aligned.so` | `a7239f3e8b090cc07e8e638d71ebef3d0d75d10dafe27f0018913a243536b3c6` |
| `pt-dynamic-aligned.so` | `0027a6d02f416e1ab57a8875bbebcc7bf70c80cdf046e47338200592f503deb6` |
| `pt-dynamic-unaligned.so` | `1094d73e0289202e9ddb87dd42f6f6e694a7aa7b548de891d03e9359fa2176da` |

Loader confirmation used the prebuilt `target/debug/bend-test-runner` from the
main checkout (SHA-256
`90d37f76abaffcc589c203a464ae5d4293fae7039336ada3285e8ae4e5bd31d7`). Its
JSON-lines `load` operation runs LiteSVM 0.7.1; the
`send` checks above executed only inside that in-memory test VM. No validator,
RPC endpoint, wallet, or deployment was used. This confirms the recorded loader
choices for these fixtures; it is not a general proof of the checker or a
replacement for independent review.

## Final-ELF build gates

The ordinary `npm run build` path checks the linked `build/escrow.so` before it
publishes `build/manifest.json`. `buildProgram` performs the same check after
linking every project ELF and before it publishes the project manifest or logs
success. This covers `npm run build:program`, `bend build`, and the developer
acceptance path that calls `buildProgram`. The mixed Rust/Bend harness checks
`build/mixed-library/mixed-library.so` after the Rust linker combines it with
the Bend relocatable object and before it publishes `acceptance.json`. The
relocatable Bend object is not a final program and receives no call-depth claim.

An accepted receipt binds the final ELF path, SHA-256 and byte length, checker
source path and SHA-256, supported SBPFv0 profile and assumptions, analysis
result, and a unique report path/hash/length. The ordinary and project manifests
also bind the receipt and their current compiler-input hashes; mixed acceptance
binds the receipt and includes the report as an artifact. The shared publisher
rechecks the receipt immediately before invoking the success publisher.

Build manifests carry a per-build `buildRunId` separately from the gate
receipt's `runId`. A successful receipt is still embedded in the published
manifest. Reproducibility tests validate both run receipts against each run's
actual ELF and report, then compare stable manifest content while excluding the
run IDs, prior archive location, output path, and per-run report identity.
They also compare the complete checker report after removing only its run ID
and output path.
Artifact hashes and lengths, checker hash, profile, assumptions, analysis,
inputs, toolchain, generated schemas, interfaces, and ABI identities remain in
that comparison. If the final publication callback throws after the checker has
accepted the ELF, the checker report remains as an accepted intermediate
observation and a separate publication-refusal report records `status: refused`,
the failure, artifact identity, and correlated build and gate run IDs. This
refusal means the build did not publish success.

The checker source path is resolved relative to the artifact helper module, so
its identity does not depend on the caller's current directory. The surrounding
build scripts still use repository-relative source and output paths and must be
run from the repository root. The file hash records the checker source bytes
read during the gate. It does not prove that the JavaScript runtime loaded those
exact bytes, and these hashes do not close a malicious load/read time-of-check
to time-of-use race.

Build input hashes are currently collected after compilation. A source change
during a build can therefore make the manifest's input hashes describe bytes
different from the ones used to produce the ELF; this pre-existing snapshot race
is not fixed by the call-depth receipt.

A refused analysis writes a report with its refusal code and diagnostics before
throwing. If the checker itself throws, the report records the ELF, checker
hash, and thrown error with `checkerReport: null`. The ordinary and project
builds move the refused ELF out of the usual `.so` path; the mixed harness does
the same for its linked ELF. Per-run reports remain available, and earlier
successful manifests/ELFs are archived before a replacement build starts.

`compileSbf` is also exported as a raw compile/link helper. Calls to it do not
run the final-ELF gate. The raw helper is used by
`scripts/benchmark-arithmetic-probe.ts`, `scripts/benchmark-linear.ts`,
`scripts/benchmark-linear-fold.ts`, `scripts/benchmark-linear-diagnostic.ts`,
and `scripts/benchmark-rmsnorm.ts`, as well as focused test harnesses. The
phase and native-arithmetic benchmark scripts
(`scripts/benchmark-amm-phases.ts`, `scripts/benchmark-rmsnorm-phases.ts`, and
`scripts/benchmark-rmsnorm-native-arithmetic.ts`) invoke `ld.lld` directly.
These benchmark paths publish no call-depth success receipt. A direct `ld.lld`
invocation is likewise outside the gate unless its caller explicitly passes
the resulting ELF through the artifact helper.

Current downstream ELF loaders do not independently require or verify the
receipt. In particular, `tests/sbf.rs`, `sdk/testing.ts`, and the live-queue
runner load `.so` bytes directly; a hand-placed or older ELF can therefore be
loaded without receipt enforcement. The `bend build` and `bend test` workflows
rebuild through the gated project path, while the fresh-developer and live
workflows use those build outputs. Their later loader/deployment steps do not
revalidate the receipt themselves.

`npm test` runs `tests/sbf-call-depth-build.ts` after the ordinary build. The
focused command `npm run test:sbf-call-depth-build` runs the same real escrow
and project pipelines, adds accepted controls, injects a non-tail recursive call
only in a private generated-C build copy, injects a real unsupported import
after linking, throws from the publication callback, and checks semantic
refusal, quarantine, publication-failure evidence, and thrown-checker evidence.
It also builds the same stem in two separate directories and uses test-owned
temporary outputs for its probes. The `npm run test:mixed-library`
command runs the actual mixed acceptance and then repeats its link in a private
source copy with a recursive Rust call; CI runs this command after `npm test`.
These tests bind the produced artifacts for each run instead of relying on a
frozen ELF digest. They exercise these pipelines and the stated checker model;
they are not a universal proof of compiler correctness or ELF safety.
