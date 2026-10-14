# Explicit qualified SHA SBF library build

Run from the repository root:

```sh
npm run build:sha256-library -- tests/sha256-mixed-library/PROOF.bend program.hash_short build/sha-library
```

The last argument is an output directory. The command derives qualification
from checked Bend source and its transitive runtime closure using the existing
[qualified emitter](sha256-qualified-emission.md). It accepts no caller-supplied
qualification receipt or identity. Ordinary `build:library` remains unchanged.
Qualification currently covers the pinned `hash_short` implementation for
lengths 0–55 and the reviewed Bun 1.4.2 darwin-arm64 tuple. The separate
[packed library command](sha256-packed-qualification.md) selects its own
reviewed 0–151-byte implementation and source/root catalog. Neither command
accepts a caller-selected catalog or qualification receipt.

## Published generation

Read `active.json`, resolve its `generation` inside the output directory, and
use its `selection` fields. The selected host source/object are ordinary
checked-source C. The selected SBF source/object replace exactly the qualified
internal SHA definition while retaining the ordinary canonical wrapper,
public schema, generated header and Rust bindings. The ordinary SBF object and
its private manifest remain in the generation as comparison evidence.

The command archives an existing active receipt before setup or proof checking.
It builds under a unique staging directory, checks inputs and artifact hashes,
moves the artifacts to a unique generation directory, rechecks them, and
publishes the active receipt last. A directory lock excludes competing builds.
After acquiring the lock, a failed build leaves no active receipt;
`failure-<id>.json`, the prior archived
receipt and prior generation preserve evidence. Stage or generation files left
by a failure are not a successful publication. Receipts bind source/support
inputs, tools, ordinary and qualified artifacts, qualification, imports and
stack reports. Archive and generation files should be retained together.
Refusal to acquire an already-held lock leaves the existing active receipt and
generation unchanged. A competing build cannot retire another build's success.

## Object and final image checks

The SBF object uses pinned Anza Clang 20.1.7, requires genuinely unresolved
`abort` and `sol_sha256`, permits only the listed memory imports in addition,
requires the public ABI export, and limits static Clang stack frames to 4,096
bytes. Object bytes are hashed before and after profile checks and checked
again before publication.

`finalElfAuthorized` is always false in the library receipt. Linking the object
into Rust changes the artifact being assessed. The final SBPFv0 image must
separately satisfy the qualification's import profile, final stack bounds and
the maintained final-ELF call-depth/artifact gate. The focused test demonstrates
these checks for its own two linked images; it does not authorize another
consumer's image. The [library ABI contract](../tests/mixed-library/fixture.md)
still governs canonical encodings, pointer preconditions and error handling.

Byte binding assumes a trusted process and stable, non-hostile filesystem.
Bend, LLVM, inspection tools and the SHA syscall remain trusted. Recorded
executable hashes are evidence, not a reviewed tool digest allowlist.

## Focused acceptance

```sh
npm run test:sha256-qualified-library
```

The test builds the maintained LiteSVM runner with Cargo `--locked --offline`,
using the existing `scripts/test-runner/target` cache. It records source and lock
hashes, the actual installed host Rust/Cargo versions and executable hashes,
Cargo metadata/build transcripts and the runtime handshake. A retained copy
inside the run directory is checked before and after execution; later cache
rebuilds do not change that input. `SHA256_SHORT_SBF_RUNNER`, when supplied,
must match the fresh build's bytes. No dependencies are installed. The documented
host Rust version is 1.92.0; the receipt records the version actually used.

Five controls reject changed retained executable bytes, changed build evidence,
an omitted source binding, an incorrect lock binding and the wrong runtime,
then verify restoration. These checks supplement the publication controls below.

Nine controls exercise failures after ordinary build, after qualified object
compilation, after generation publication, before active receipt publication,
object swaps before and after profile checking, an actual Bend proof hole,
selection of the other fixed SHA profile, and an already-held publication lock.
The first eight must retire success, preserve the exact prior receipt and
artifact bytes, release their lock and record failure. The held-lock control
must preserve active success and the directory contents. A fresh real build
restores publication into a new generation.

The test compares 64 cases against Node crypto and the ordinary host library
under ASan/UBSan. It then runs 65 LiteSVM cases on each ordinary and qualified
Rust-linked image, including malformed canonical input. It covers all lengths
0–55, high bytes, poisoned inactive words and invalid lengths/active bytes;
checks missing imports and final-image byte tampering; and records hashes of
executing sources, artifacts, tools, raw requests/responses and failure evidence
under `build/sha256-qualified-library/run-<id>/`.

These are finite execution and mutation checks. They do not establish universal
SHA equivalence, an end-to-end verified compiler, deployment behavior or
production readiness. Full refinement-suite evidence is separate.

## Recorded integration acceptance — 2026-10-06 UTC

The fresh short-profile replay passed all nine controls, 64 sanitizer cases
and 65 cases per final ordinary/qualified Rust-SBF image:
`build/sha256-qualified-library/run-40a8ac96-f869-4702-b636-c2bcaaf194f4/report.json`.
The independent two-profile publication audit checks 197 input, receipt,
artifact and execution bindings:
`build/sha-packed-publication/publication-audit-89735172-a916-414f-8973-693ed2ef88f6.json`.

Integrated `npm test` and its source/log audit passed for 931 recorded sources
in `build/overnight/regression-fe0d9b24-b3ed-4a8e-9d95-4ccbb4c3e19f/`.
The subsequent CI-ordered program-client, project-command and client-packaging
checks and audit passed in
`build/sha-library-integration/client-checks-e90c502a-b26f-49f1-bd78-b0b0c7367e44/`.
Both have terminal success and no source drift; the broad directory's
`finish.json` binds the audit/check ordering. Documentation updates followed
these audits. This closes the publication integration gate for those inputs;
it does not replace consumer-specific final-image checks or the outstanding
full refinement aggregate.
