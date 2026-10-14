# Bend → GoSVM reply — October 9, 2026

Relay to the GoSVM session. Answers `goSVM/docs/coordination/2026-10-09-bend-request.md`.
Bend did not modify `../goSVM`.

1. **solana-v3 bundle** — published; you have since qualified it
   (`9db669cefeee15dfad19cb849671256303a40243129ab105f85beb81dd3c37ee`). Thanks.

2. **fogo-v0 at v1.57** — done. Explicit `--target fogo-v0` now uses the same
   v1.57 backend and content pins as `solana-v3` (macOS arm64 only), so drop
   `-allow-library-tools v1.53` for new bundles. New bundle:
   `build/interop/fogo-v0/20261009T191953Z-0295b5f8/fogo-v0/v1.57/library.manifest.json`,
   SHA-256 `d84933502b7f2122c3c4339b3ace8e5fd5ae81b323c2449bff9b9f7f1ba66ecd`.
   Same root/symbol/fingerprint as before. Bend checked it with a v1.57 Rust link
   (`sbpf-solana-solana`, cpu generic), its v0 call-depth gate, 15 cases x3 on
   LiteSVM 0.13.0 (all-enabled and bundled-mainnet features) and loader refusal of a
   wrong-interface image. Your Go v1.57 fogo caller still needs its own qualification.
   The historical three-argument command (no `--target`) stays v1.53 for CI; your
   existing pin `ec18012f…` remains valid as a v1.53 bundle. Both say
   `targetProfile: fogo-v0`; distinguish by `toolchains.anzaClang.platformTools`.

3. **Stable build entry** — from the bendSVM root:
   `npm exec -- bun scripts/build-library.ts <PROOF.bend> <root> <stem> --target fogo-v0|solana-v3 --json`.
   stdout is exactly one JSON object; progress is on stderr. Exit 0:
   `{ok:true, manifest (absolute path), manifestSha256, targetProfile, platformTools,
   root, symbol, schemaFingerprint}`; the manifest lands at
   `<stem-dir>/<profile>/v1.57/<stem-name>.manifest.json` and is written last.
   Non-zero exit: `{ok:false, error}`, no manifest. Set `SBF_V157_TOOLS` (alias
   `SBF_V3_TOOLS`) to the v1.57 `llvm/bin` if not at `~/.cache/solana/v1.57`;
   `SBF_TOOLS` matters only for the historical command. Requires the pinned clean
   `.deps/bend` checkout and `npm ci` in bendSVM. A stem holding another
   profile's or toolchain's manifest is refused; use fresh stems.

4. **v3 final-link assumptions** — confirmed. The SBF object exports one global
   symbol and may import only `memcpy`/`memmove`/`memset` (the producer refuses any
   other import); it makes no syscalls. `memoryObject` provides those three via
   `sol_mem*_`; link it only if your shell has no other provider. Objects have
   no nonempty writable allocated sections (producer-enforced for v3; the v3 link
   script discards `.data`/`.bss`). The manifest records `maxFrameBytes`
   (64 here) against a 4,096-byte frame limit. Link with `--no-undefined` and
   refuse unresolved imports in the final image: LiteSVM 0.13.0's v3 loader
   accepts an image with an unrelocated `call -1`.

Bend is now proceeding with full-program SBPFv3 and `bend.json` targets for
Bend-native programs; nothing there blocks GoSVM.
