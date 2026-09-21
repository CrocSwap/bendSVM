# Developer workflow acceptance

Status: accepted. The evidence audit passes against the current worktree and
records source/artifact identities in `build/developer-workflow-acceptance.json`.

The full objective and six requirements are in
[developer-workflow-plan.md](developer-workflow-plan.md).
The external-alpha packaging path now provisions TypeScript 5.2.2 through the
root npm lockfile; a host/editor TypeScript cache is not part of acceptance.

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Unified commands | `scripts/bend.ts`, project configuration and `npm run bend` | Fresh project command tests; invalid laws/proof holes fail |
| Usable project template | Owner-bound account collection, three declared laws, proofs, readable tests and generated README | Fresh path-with-spaces execution; overwrite rejection; authorization and invalid-update checks |
| Generated clients | Shared canonical codecs, named typed methods, ABI-derived account metadata, state/window decoding, portable bundles | Independent byte vectors, ABI 1/2/3 descriptor/misuse tests, strict TypeScript checks, copied client execution |
| Reusable offline runner | `sdk/testing.ts` and generic JSON-lines LiteSVM runner | Signed account creation and generated-client transactions; state decoding and atomic rejection assertions |
| Meaningful validation | Fresh template plus existing single/multi-account programs | Behavior mutation survives its unrelated source laws but fails runtime tests; contradicted source laws/proof holes fail; empty execution tests fail |
| Honest documentation | Root quickstart, project README and developer-workflow guide | Distinguishes declared source laws, application-specific SMT, SBF execution and live deployment |

## Final gates

Run the command/client/packaging/end-to-end tests, current fresh-output
reproducibility checks, unchanged-ELF checks for existing public applications,
and the existing SBF regression suite. The client packaging test uses the pinned
`node_modules/typescript/lib/tsc.js` (or accepts `TSC_JS` only when it reports
the same 5.2.2 version). The normal developer workflow needs Bun and the
existing build/test toolchain.

The final audit must inspect current report/manifest input hashes and generated
artifact hashes, each ABI's executed transactions and rejection checks, static
type-check evidence and reproducible client outputs. It records a new acceptance
snapshot; older milestones remain historical evidence.

Observed results: the fresh collection and existing multi/single-account projects
execute 14 transactions (nine successes and five expected rejections), with 31
assertions. Their test reports are indexed by `build/workflow-e2e.json`. All 78
existing SBF regression tests pass, with zero failures and three benchmark-only
tests ignored by the normal runner. Seven public program builds reproduce their
artifacts; the vault/vesting/exchange checks also match the previous test ELFs.
Strict TypeScript 5.2.2 positive/negative client checks and copied portable-client
execution pass, recorded in `build/client-packaging-report.json`.

Reproduce the gates from the repository root with fixture artifacts available
(the existing `npm test` prepares them):

```sh
npm exec -- bun tests/project-commands.ts > build/workflow-commands.log 2>&1
npm exec -- bun tests/program-client.ts > build/workflow-client.log 2>&1
npm exec -- bun tests/workflow-sbf.ts > build/workflow-e2e.log 2>&1
npm exec -- bun scripts/check-collection-builds.ts > build/workflow-reproducibility.log 2>&1
npm exec -- bun -e 'await (await import("./tests/builds.ts")).testBuilds()' > build/workflow-regression-builds.log 2>&1
npm exec -- bun tests/client-packaging.ts > build/workflow-packaging.log 2>&1
cargo test --locked --test sbf -- --nocapture > build/workflow-sbf-regression.log 2>&1
npm exec -- bun scripts/audit-developer-workflow.ts
```

Honor command exit statuses. The audit removes its prior marker and writes a new
one only after matching current reports, manifests, inputs, artifact hashes and
the required result logs. Tests are scoped to the added workflow and existing SBF
behavior; this milestone did not rerun the unrelated long arithmetic SMT suite or
claim new proofs about compiler lowering.

## Boundaries

No C, Rust adapter or manual instruction encoding is required in a generated
project. The tool implementation itself uses Rust to host LiteSVM. The starter's
source imports the shared SDK; portable clients contain their runtime. Remaining
accounts for token/CPI effects are explicit application responsibilities.

The tests execute SBF in LiteSVM, not through a live RPC deployment. The source
law command checks only the laws actually supplied by the developer. It neither
generates arbitrary invariants nor verifies compiler lowering. TypeScript/Bun
execution tests use runtime assertions; the separate packaging gate checks the
generated client types. Existing language, window and resource bounds remain.
