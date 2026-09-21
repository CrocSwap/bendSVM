# Account-backed collections acceptance review

Status: accepted. The complete runtime regression, 17-command refinement suite,
fresh-build reproducibility checks, refreshed Rust benchmark and evidence audit
all passed. `build/account-collections-acceptance.json` records the accepted
source and artifact hashes.

The objective and required evidence are preserved in
[account-collections-plan.md](account-collections-plan.md).

| Requirement | Implementation and evidence | Status |
| --- | --- | --- |
| Reusable Bend APIs | Metadata, ranges, generic typed windows, checked global reads/updates and bounded local appends; 860 differential cases; U32/Bool and backing capacities two/four | Full regression passes |
| Larger account storage | Generated ABI 3 decodes/commits only selected records; U32 allocation 16,440 bytes, typed record allocation 12,344 bytes, queue allocation 11,064 bytes; distant updates preserve untouched bytes | Targeted SBF tests pass |
| Safety contract | Capacity/length/offset checks; canonical active record checks; exact appends/no holes/truncation; owner/writable/schema/state binding; alias/CPI privilege checks; atomic failures and initialization tests | Native sanitizer and SBF tests pass |
| Developer diagnostics | Stable category/detail/function/hint; native/wire size reports; Clang per-function stack reports; source/layout/oversized value/frame negatives and CLI failures | Targeted tests pass |
| Source invariants | Nine collection contracts; 428 queue outcome/range/progress/conservation claims; checked arithmetic binding; five collection mutations and seven queue mutations with concrete Bend replay for the queue | Complete 17-command refinement suite passes; report and source hashes verified |
| Acceptance application | Funded append, seal, one/two-record settlement across transactions, cursor progress, owner/custody/recipient binding, replay guards, conservation, full-U64 overflow and late-CPI rollback | Four shared SBF conformance tests pass |
| Independent Rust | Standalone native arrays, checked arithmetic, codecs and account/token adapter; no generated Bend C; same protocol | Shared conformance passes |
| Benchmark | 26 matched operations at capacities 2/64/256; exact inputs/post-state/errors, repeated compute reports and manifests; settlement about 2.28–2.45x Rust | Refreshed benchmark passes with current resource reports and manifests |
| Regression/workflow | Existing applications, public CLI/client, fresh-output deterministic artifacts including resource reports, complete runtime and 17-command refinement suites | All gates pass; 78 runtime tests passed, zero failures, three benchmark-only tests ignored by the normal runner |

## Final gates

```sh
npm test > build/account-collections-regression.log 2>&1
npm run verify:all > build/account-collections-refinement-suite.log 2>&1
npm exec -- bun scripts/check-collection-builds.ts
npm run benchmark:queue
npm exec -- bun scripts/audit-account-collections.ts
```

Honor all command exit statuses. The audit validates current source/artifact
hashes, proof coverage/mutations/bindings, current manifests, reproducibility,
matching repeated benchmark fixtures and complete suite logs. It removes the old
acceptance marker before validating and writes a new one only on success.

The runtime log is `build/account-collections-regression.log`; proof command
results are in `build/refinement-suite.json` and the corresponding refinement
log. `build/collection-reproducibility.json` covers the three collection fixtures
and queue; `build/reproducibility.json` covers vault, vesting and exchange.
`build/queue-benchmark.json` binds both implementations, all 26 matched operations
and repeated measurements. Its dedicated command runs the queue benchmark that
the normal test runner deliberately ignores. Historical AMM and batch benchmarks
remain separate from this milestone's queue comparison.

## Limits and trust boundary

The initial ABI supports one collection account, fixed-width canonical records,
nonrecursive elements and one/two/four/eight-slot backing windows, subject to
native/wire/stack limits. It supports append and replacement, not truncation or
allocation growth. Programs must supply an authorization policy and bind the
collection key in their small state. Raw collection/CPI probes deliberately have
no application policy and are not deployment templates.

The queue proofs establish checked-source outcomes through explicit arithmetic
and key-equality composition. Adapter serialization and account validation,
C/LLVM/SBF lowering, Solana runtime and external programs remain outside that
proof. Native sanitizers, actual SBF transactions and independent Rust conformance
are separate execution evidence. No unrestricted Bend compatibility, worst-case
compute guarantee, security audit, live-cluster deployment or end-to-end verified
binary is claimed. See queue-refinement.md and diagnostics.md for details.
