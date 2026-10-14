# Bend → GoSVM reply — October 14, 2026

Reply to `../goSVM/docs/coordination/2026-10-14-bend-build-request.md`. No Bend
library code changed for this reply; every answer below was checked on
2026-10-14 (macOS arm64) with the probe commands noted.

## fogo-v0 at v1.57: already published

Published 2026-10-09 (see the [October 9 reply](2026-10-09-gosvm-reply.md)):

- manifest `build/interop/fogo-v0/20261009T191953Z-0295b5f8/fogo-v0/v1.57/library.manifest.json`
- SHA-256 `d84933502b7f2122c3c4339b3ace8e5fd5ae81b323c2449bff9b9f7f1ba66ecd`

## Consumer-invoked builds

```sh
npm --prefix <bendSVM> run -s build:library -- <PROOF.bend> <root> <stem> --target fogo-v0|solana-v3 --json
```

1. **Output location: yes, chosen by the caller.** `<stem>` may be any
   absolute path, including one outside the checkout. The bundle lands at
   `dirname(<stem>)/<profile>/<platformTools>/<basename(<stem>)>.*`. For example,
   `<project>/build/bend-libraries/<name>/<key>/library` produces
   `…/<key>/solana-v3/v1.57/library.manifest.json` plus objects. No separate
   `--out` flag is needed. A build with an existing checkout and pinned Bend
   dependency wrote no files inside `bendSVM` (checked with a timestamp marker).
   On the first run, without `.deps/bend`, it fetches the pinned Bend commit
   into the checkout (network).
2. **Machine-readable result: available now.** `--json` prints one object on
   stdout: `{ok:true, manifest (absolute), manifestSha256, targetProfile,
   platformTools, root, symbol, schemaFingerprint}`. Human logs go to stderr.
   On failure it prints `{ok:false, error}`. See `docs/library-artifact-contract.md`.
3. **Exit status: non-zero on any failure**, including check, proof-gate,
   unknown-root, toolchain-pin and header/section refusals. For example, root
   `mixed.nosuch` exits 1 with `{"ok":false,"error":"Library root was not emitted: mixed.nosuch"}`.
4. **Invocation contract.**
   - Working directory: the bendSVM checkout. `npm --prefix <bendSVM> run …`
     already runs the script from there, so it worked when invoked from `/tmp`.
     Pass absolute source and stem paths.
   - Prerequisites: `npm ci` in the checkout. That provides Bun 1.4.2, which runs
     the script; CI uses Node 22. You also need a clean `.deps/bend` at
     `7561656155a4285c1e4ccfcb3505ab59524de973` and host `clang` (or `CC`) for
     the host-test object.
   - Both explicit targets (`fogo-v0` and `solana-v3`) use platform-tools v1.57.
     Point `SBF_V157_TOOLS` (or its alias `SBF_V3_TOOLS`) at the `llvm/bin`
     directory. The default is `~/.cache/solana/v1.57/platform-tools/llvm/bin`.
   - Bend checks `clang` and `llvm-readelf` by content against the v1.57
     release binaries for macOS arm64, Linux x86_64 and Linux aarch64
     (`V157_HOSTS` in `compiler/target-profile.ts`, which also pins each release
     archive's SHA-256). `npm run install:platform-tools -- --root <dir>` installs
     a hash-checked copy. Your macOS ld.lld pin already matches ours. A
     GoSVM-pinned root works only if those binaries are the same release files,
     which the content check verifies.
   - `SBF_TOOLS` (v1.53) applies only to the historical command without
     `--target`.
5. **Reproducibility: the same source, root, target and toolchain give a
   byte-identical bundle, wherever it is written.** Since the same day's
   follow-up, explicit-target builds pass `-ffile-prefix-map` for the output
   directory, so the stack-usage reports (`*.su`) no longer embed it. Two
   solana-v3 builds (and two fogo-v0 builds) into different directories, one
   with a space in its path, produced identical trees and `manifestSha256`.
   Every object (`library.sbf.o`, `library.sbf.memory.o`, `library.host.o`), the
   C source and the header are byte-identical to the published 2026-10-09
   bundles. Only the `.su` contents and so the manifest hash differ from them, so
   a rebuilt bundle needs one re-pin. Machine-independence across hosts is not
   claimed; Linux uses different pinned binaries. The historical command without
   `--target` is unchanged.

Caveat: Bend reruns no qualification for consumer builds. A rebuilt bundle is
evidence for its own recorded inputs and hashes. The published, qualified
bundles stay the reference.
