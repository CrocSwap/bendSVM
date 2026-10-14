# Source-qualified SHA SBF emission

`emitSha256QualifiedSbf(sourcePath, runtimeRoots)` is an explicit intermediate
operation in `compiler/sha256-qualified-emission.ts`. Ordinary builds, native
compilation and ordinary library builds do not call it. The separate
`build:sha256-program` and `build:sha256-library` commands derive qualification
internally from the checked source path and runtime roots. A digest, boolean, receipt, target name or
caller-created identity cannot authorize substitution.

## Qualification and emission

The operation runs `checkedProgram` first, retaining its single checked book
and actual loader map. The existing Bend checking, proof/law validation,
unsafe/foreign rejection and Backend subset checks stay on the path. It then:

1. Applies `validateCheckedSourcePaths` to that loader map.
2. Hashes every loaded source, including the entry `PROOF.bend`, loaded law
   files and all other imported files. It locates the SHA reference, buffer and
   iteration modules only by one unique full-byte match each to the reviewed
   hashes in the module-relative
   [qualification catalog](../compiler/sha256-qualification-pins.json).
3. Uses those resolved loader-map origins with `checkedModuleNames` to
   canonicalize relocated namespaces and generic instances. It compares the
   complete checked runtime closure against the reviewed 160-definition
   identity rooted at `$module:sha256-reference.hash_short`.
4. Resolves the raw SHA function name from the pinned module's declaration
   origins. `Backend` must emit that exact function through the caller's normal
   runtime roots, and the function must remain transitive rather than becoming
   a public root. An imported but unused SDK function, a direct SDK root, or an
   unrelated same-shaped user function cannot select the replacement target.
5. Uses the internal `Backend.emittedFunctions()` record for the target's
   checked name, C name, signature and exact generated C definition. Every
   record is cross-checked against the ordinary emitted function list, schema
   C types and its generated C header; the ordinary public exports must agree
   with their records. It builds a temporary schema with that one internal
   export, runs the existing `generateSha256Short`, with only the internal
   function's transitive schema types and its one internal export, and replaces
   exactly one definition. The output keeps every other emitted definition
   byte-for-byte and leaves the original public roots and schema intact.

The same checked book is used for identity and emission. There is no `await`
between identity, ordinary emission, schema generation, substitution and the
second identity check. The operation hashes source and support inputs before
and after those phases and refuses observed changes. Its assumption covers a
trusted process with no hostile in-process patch authority and a stable,
non-hostile filesystem from import-time module loading through final output.
The checked loader's map and these hashes are **not read-time byte receipts**;
this layer does not claim to resist a writer that changes and restores bytes
during the upstream loader.

## Pins and output

The catalog is loaded relative to the emitter module, never the caller's
working directory. The module pins the catalog's exact bytes; its own source is
bound by a normalized self-hash that replaces only the embedded catalog digest.
The catalog pins the other compiler/identity/type-evaluation/generator files,
the SHA runtime headers and link support files, the 1.4.2 Bun executable, and a
clean Bend checkout at `7561656155a4285c1e4ccfcb3505ab59524de973`. The current
catalog supports the reviewed Bun 1.4.2 executable on **darwin-arm64** only;
other platform/architecture tuples are refused before executable lookup. No
Linux or other platform executable hash is asserted. A future reviewed catalog
can add platform-specific pins. The runtime also refuses a
working-directory/module-root mismatch. Pin refresh is a reviewed maintenance
change: update the hashes deliberately and rerun the focused acceptance.
Invocation never treats current files as new authority and does not download or
install another platform's Bun.

The returned object and nested receipt are frozen. Its original Backend
emission keeps `taggedSumLowering` evidence next to the `originalC` hash only.
The substituted C is returned separately and has no original tagged-sum
evidence attached. The receipt binds the normalized checked graph, every
loaded source and support pin, original C/schema/evidence, original and
replacement definition hashes, resulting C hash, and the required final SBF
profile. The returned public schema is the unchanged original schema, which is
hashed once with the ordinary emission.

The returned object and receipt are descriptive evidence, not a capability;
they can be forged or spliced into another result. The explicit program build
invokes qualification internally and never accepts caller-supplied receipts as
authorization. This emission layer does not build or authorize an ELF. The
separate command checks the linked image and binds it to Anza platform-tools
v1.53 / Clang and LLD 20.1.7 SBPFv0, required `abort` and `sol_sha256` imports,
absence of `sol_log_64_`, the 4,096-byte frame bound, final-ELF call depth, and
artifact hashes. See [qualified SHA builds](sha256-qualified-build.md). The
ordinary import profile is unchanged. The separate
[qualified library path](sha256-qualified-library.md) checks and publishes an
SBF object; its host C remains the source-generated reference. Final linked
image checks remain the library consumer's responsibility.

## Focused acceptance

Run from the repository root with the pinned Bun and a clean pinned Bend
checkout:

```sh
bun tests/sha256-qualified-emission.ts
```

This standalone test emits the actual checked SHA source, tests a relocated
source with an earlier generic instance, and writes source-bound evidence to
`build/sha256-qualified-emission/evidence.json`. It checks source-byte and
support/catalog refusals, target reachability, proof/law and unsafe/foreign
gates, exact one-definition replacement, unchanged public schema and complete
ordinary emission, shadow buffer/iteration imports with the genuine pinned
module loaded elsewhere, in-emission book/memo/source mutations, forged
definition/signature metadata, unsupported platform refusal, and strict native
C syntax with `runtime/bend_sha256.h`.
Its report hashes the executing test, test helper, checked inputs, support
inputs and generated C artifacts. A compiler spawn or syntax error fails the
test and cannot create a success report.

The copied prerequisite tests (`checked-runtime-identity.ts`,
`checked-graph-names.ts`, and `type-evaluation*.ts`) are supporting checks for
the graph and Backend assumptions; they are not substitutes for this
end-to-end emission test. The separate reviewed 77-case optimized SBF test is
not run by this operation. The explicit build path and its 64-case actual-final-
ELF acceptance are documented in [qualified SHA builds](sha256-qualified-build.md).

These checks are finite input, mutation and syntax evidence. They do not prove
universal SHA-256 equivalence, arbitrary source-to-binary preservation, an
end-to-end verified compiler, or final ELF correctness.
