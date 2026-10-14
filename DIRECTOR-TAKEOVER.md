# Director takeover checkpoint — current resume note 2026-10-09

**Read [docs/director-handoff.md](docs/director-handoff.md) first.** It records
the completed Go/Bend/Rust v0 coordination, authorized but unfinished modern
v3 library implementation, exact evidence and next checks. Pending-work
statements below are historical. The earlier five-item goal has a recorded
completion decision; modern v3 execution qualification has not run. Preserve
the dirty/untracked workspace and ignored evidence across reset.

## Promoted writer and current assurance work — 2026-10-06

The generic per-call scanner writer now uses two bounded byte copies. Maintained
scanner qualification `build/dcg-result-scan/run-40e2d79d-1078-479c-8490-06cd2a122679/`
passed; a read-only terminal check confirms all 138 source inputs and artifact/tool
bindings. All 737 matched whole-record CU cases improve, with unchanged independent
Rust CU; total checked CU is 12,897,559 versus 15,368,506 (16.1% lower). Checked
Rust stack frame is 896 bytes, and the unchanged final-image checker accepts nine
modeled active frames. These measurements are scanner scope, not whole 172 or
capacity-wide closure. Comparison: `build/dcg-result-scan/development/current-writer-comparison-20261006.json`.

Full disposal qualification after promotion is terminal PASSED:
`build/dcg-dispose-executor/run-19b8eb9f-3266-44d7-a9c9-03ea63a4514b/`.
All 48 native tests/18 inventories, nested gates, pure SBF outputs and fresh
four-route readiness completed. Independent audit and read-only post-terminal
check pass 336 current inputs, 852 audit bindings and twelve checked receipts.
Report SHA: `e237a416e8ce316f88ee9147699dc1f6cd680c2c2311d8eec1ff030f597a58bc`.
Audit SHA: `2fb8e5dc8f75423ba64b45be1e8596d926a30a16b60d9bf30bafd1f6c91254fb`.
Fresh readiness: `build/dcg-settlement-sbf-readiness/run-7827b102-d3b9-4b73-b75f-b3ece24330a5/`.
The account replay against this exact new image is terminal PASSED:
`build/dcg-settlement-sbf-replay/run-7f8bc591-5fd0-4eea-9fd9-2b3e36a43546/`.
Eight STANDARD/CUSTOM SBF account executions match native account states;
two later-instruction rollbacks and two repeat refusals pass. Independent
reexecution and read-only terminal audit pass 345 current inputs/355 audit
bindings. Report SHA: `9bf19cef099301054f316c1afa702893ab640dfab3c1a5a9ab6639ad7be9625a`.
Audit SHA: `2956e73b16d5ac9786fe14dd39d3d2e1f00c4b4344dc1056c01c5337e46a281e`.
Read-only terminal/CU comparison: `build/overnight/dispose-writer-replay-terminal-20261006.json`.
All twelve recorded sequence/control CU values are unchanged versus the previous
image. The measured 16.1% gain is scanner benchmark scope, not a whole-handler
speedup. No own qualification jobs remain live. Previous owning
f57 and account replay 40f receipts establish their pre-promotion snapshots.
Replay 40f did complete: eight SBF account executions, two later-instruction
rollbacks and two repeat refusals, independently reexecuted; report SHA
`62556fe98cff287bb4fb02b89dde2a5b37d489df266a5c24d9470456be5ec104`, audit SHA
`212a91c10472555a5e190ca20ff15fc073c6d7f2b481b24c8d1715529500ebfc`.

The current maintained quotient refresh is terminal PASSED, including a fresh
qualification, model tests, four real process failures and 304 report-corruption
refusals. `build/sbf-quotient-test.json` SHA:
`2e463104dc81ec66bc97958d957bc6b1a9956d30efbddc38c75c9e15ba816d05`.
Its 15 reports/ten phases include complete current four-route arithmetic,
19 small-slice claims/controls, actual product/clock input binding, 68 induction
obligations, four small Euclidean claims, 182 valid caller VM cases and nine
semantic/domain refusals. Read-only terminal audit:
`build/overnight/quotient-refresh-20261006/focused-current-terminal-audit.json`.
Old c9 refresh is a preserved preceding snapshot; the focused f58 qualification
is current after added malformed-DIV controls and explicit small dividend bounds.

The current owning handler gate and maintained focused tests are terminal PASSED.
Owning run: `build/sbf-handler/runs/2564f850-cb18-4afb-8bdb-e6cd4bb6e5b2/`;
focused receipt: `build/sbf-handler-test.json` (SHA
`1a080df3b82f14b11343193450aad659d8ddd96a65f3a03aafa46f5ba5d8dff5`).
The fresh focused qualification passes all 17 phases, 520 baseline whole-output
VM cases (the original 448 plus 72 nonzero-high small-divisor cases), 16 fault
comparisons, four process failures, 302 report refusals and 13 clear-connection
refusals. All 360 output bytes are compared. Current dispatch, payout,
authorization, Claim/Initialize/rejection output, frames and memset wrapper are
bound to the current image. The deferred unauthorized backward edge is checked
against the exact branch/mask, without widening the shared acyclic interpreter.
Read-only terminal audit (108 bindings plus strict report validation):
`build/overnight/quotient-refresh-20261006/handler-focused-current-terminal-audit.json`.
The preceding failed 5cad run and private component evidence remain preserved
snapshots; they are superseded by this current full owning/focused qualification.

The dependent maintained call-frame focused test is terminal PASSED:
`build/sbf-call-frame-test.json` (SHA
`cebd9177419de99740909f77a071c4d0aebb82672a9f79c7b25dd1aa2fa218b4`).
Four actual restoring call instances preserve the union of 17 pending output,
payout and authorization words. All three handler frame reports are required
inputs. The actual div16/div4 footprints retain 676/230 instructions and 157
accesses. Three synthetic positives, 14 model refusals, four real process failures
and 30 report refusals pass; six new controls remove each kind of pending word
or its required frame binding. Current terminal audit:
`build/overnight/quotient-refresh-20261006/call-frame-current-terminal-audit.json`.
Both gates retain their conditional memory/CALL/model assumptions; neither proves
an end-to-end compiler, account commit or whole-handler memory theorem. Next run
the complete current 55-command aggregate with maintained source hashes frozen.
Only SHA goal items 1/2 are complete. Actual CUSTOM callback/fallback finality,
retained cleanup, full SBF creation/lifecycle/capacity and broader assurance remain
open. No agents, commits, installs, deployments, Lean or wallet/RPC actions.


## Current qualification and assurance work — 2026-10-06

Owning local disposal qualification is now terminal PASSED:
`build/dcg-dispose-executor/run-f57ba21b-3074-459b-a58f-93c0537ddbec/`.
Command: `npm exec -- bun ../durable-compute-graph/scripts/test_bend_dispose_executor.ts`.
All 48 native tests in 18 inventories, fresh nested gates, 2,258 disposition
and 5,787 scanner pure SBF outputs, and fresh four-route readiness completed.
The independent audit and read-only post-terminal check passed: 336 current
inputs, 852 audit bindings and twelve recursively checked receipts.
Report SHA: `92dd78d237111d7ce536b12adf24553abbed644d743f31fde3642c6a5f02fb2f`.
Audit SHA: `4d858973d533e74bb4bf3384d8a2be3349d7af1315321df8493cd017f11cc392`.
Readiness: `build/dcg-settlement-sbf-readiness/run-b9f14f18-c86a-4d32-8b93-6fc29eee4036/`.
All previous owning failures remain recorded failures. Frozen unified source
and six v1 compatibility pins are unchanged. This qualification does not claim
actual CUSTOM finality, cleanup, full SBF creation/lifecycle or complete capacity.

A maintained account replay against the preceding accepted libraries and image
is terminal PASSED (pre-writer-promotion snapshot):
`build/dcg-settlement-sbf-replay/run-40f93849-3ad0-426e-a29d-125785f41780/`.
Its eight SBF executions, rollback and repeat controls completed with independent
reexecution. The new writer needs fresh owning and account-replay qualification.

Broader assurance work reproduced the current quotient gate failure:
`build/sbf-quotient/runs/34bad0d0-2c0c-4f9e-8570-30674dea5ff9/`.
The div16/div4 helper interval moved by 560 bytes but all 7,360 instruction
bytes are identical. Maintained helper proof/control addresses and matching
strict schema constants were rebased. A fresh owning attempt
`build/sbf-quotient/runs/b68f2b30-c3a2-402a-af34-9d502878c561/`
passed the composed 658 inline/16 frame/229 nested-leaf instruction certificate,
then refused the still-obsolete caller model. It remains FAILED, with no latest
success pointer. Current SDK wide division adds a 128/32 branch and changes
caller register/spill allocation; it cannot be repaired by address changes alone.
Maintained current caller/overflow/router/product-entry models are being updated.
Development checks pass exact four-call quotient/context restoration (41 actual
caller instructions), the 24-instruction overflow guard with a semantic boundary
fault, four exclusive division routes, and complete restoring-call input binding.
These private checks do not establish complete quotient or aggregate acceptance.
Evidence and source backups: `build/overnight/quotient-refresh-20261006/`.
Next: qualify the native64/128-by-32 branches, current complete caller VM replay,
strict report/process controls, then broader aggregate verification. Generic
measured CU candidate is now promoted; full qualification after promotion remains open. No agents, commits, deployments,
installs, Lean or wallet/RPC actions were used.


## Latest qualification checkpoint — 2026-10-06

The optimized owning disposal run is terminal FAILED:
`build/dcg-dispose-executor/run-51fa3382-e6ba-4862-8291-de78555176df/`.
Fresh admission, document and challenge qualification completed. Prefix native
and pure SBF checks ran, but the final source-binding check detected a change in
`crates/dcg-program/src/disputes_v21.rs`: expected `8a594f9076a9b8be5cc8db8d23958812d5147103c7e00c01d5d97efedec148ec`,
actual `efb393363709a7f7414adddb09591960a66c8870d2358767bc7f820e8ab61b59`.
The owning failure and child logs are preserved; no final owning report exists.
Exec handle 42903 is terminal and no own child qualification processes remain.
The changed source was preserved. A fresh run against stable inputs is needed;
none of the failed or partial runs establishes current owning acceptance.

The separately accepted eight-execution STANDARD/CUSTOM account replay remains
evidence for its recorded source snapshot. Later source changes mean its entire
input set must be checked again before calling it current qualification.
The implemented local 132 -> prefix -> 131 -> 172 sequence, rollback controls
and repeat-disposal refusals are distinct from the still-open real CUSTOM
callback/fallback finality, retained cleanup, full SBF creation and capacity work.
Only SHA goal items 1/2 are complete; the full five-item objective is incomplete.

Unused-disk cleanup is complete, with 6,238 disposable Rust compiler
intermediates removed (2,268,699,764 logical bytes; measured free-space increase
2,194,923,520 bytes, about 2.2 GB). The scan covered 111,258 unpacked text files
and retained all 4,040 referenced cache files, all test executables, reports,
source changes and toolchain dependencies. Scope was only main `target/debug`,
`target/arithmetic-probe`, `target/sha256` and `scripts/test-runner/target`;
sibling caches, build evidence and archived worktrees were preserved.
Inventory, checksums and read-only post-check:
`build/disk-cleanup/run-a56c61eb-770c-42ae-a6ab-efdc617aec9a/`.
Report: `report.json`; removed file inventory: `removed.jsonl`;
verification: `verification.json`. No compiler/runtime source was changed by
cleanup; rebuilding the removed cache entries may take longer on first use.


## Maintained 172 and four-route SBF readiness — 2026-10-06

Only SHA goal items 1/2 are complete; the full five-item objective remains incomplete.
Local authenticated 172 is implemented in the sibling DCG opt-in adapter,
including scoped result reads, exact result/template/pending-policy writes,
all-guards-first lamport/account mutation, working-account rent refunds and
once-only v3 retained-counter witness. Fresh native STANDARD/CUSTOM sequences
exercise opening -> 132 -> prefix -> 131 -> 172 and independently authenticate
retained outcomes after both document and challenge closure. Real CUSTOM
callback/fallback finality, retained rent cleanup, main dispatch/events,
SBF creation/full lifecycle and full close capacity remain OPEN.

The first owning disposal run
`build/dcg-dispose-executor/run-a4e1ba3d-f3d2-47d6-8ef8-2ca84715bb38/`
is FAILED even though all 47 native tests passed. Its final input check detected
fixture-loader source drift (expected `666d86...`, actual `d9b129...`). Current
`dcg-test-support/src/fixtures.rs` matches sibling HEAD; it was preserved.
No report from that run establishes owning acceptance.

SBF probes exposed real stack faults (4,864-byte entry, then 4,352-byte handler).
Maintained source now separates 172 authentication/decision/physical commit,
uses private owning document/policy snapshot allocations in bounded activations
for 132/prefix/131/172, and outlines checked transport calls. A shared private
iterative Pair preorder replaces recursive ledger/prefix wire walks. This
changes neither canonical bytes nor checked Bend business rules. Frozen unified
source is still at HEAD; no deployed image or v1 pin was changed.

Focused current native parity passes five tests:
`build/dcg-dispose-executor/development/native-03120c08-1b67-4361-8e6e-84bb0bcf8fde/`.
Includes all 2,258 independent disposal input/decision cases, 987 settlement
cases, 662 prefix cases and both native disposal whole-account lifecycle tests.
Native log SHA: `ba579b74d7f2dc8983f967aefba8d66456e0dd13fe20d65ce608a95d0815ef65`.

The maintained offline readiness builder and independent audit pass:
`build/dcg-settlement-sbf-readiness/run-f7ef7a53-3c59-4c62-8ce5-e67e3e80074f/`.
The exact maintained four-route SBPFv0 wrapper has 101 reported Rust stack-size
entries, maximum 2,176 bytes; all eight bound library C frames fit 4,096 bytes.
The UNCHANGED final-image checker accepts twelve modeled active frames.
Static panic diagnostics plus the abort syscall/closed defensive loop remove
indirect formatting. The generated wrapper includes an explicit panic control,
not a main application route. LiteSVM loads the image, rejects malformed packets
for all four routes and verifies abort at 358 CU plus complete rollback after
an intentional account write. This does NOT establish successful authenticated
132/131/172 account execution or full lifecycle/capacity.
Report SHA: `c982052cb7c46cb3c8318e6df2041fac851c40b2164761f492862b202eefddc9`.
Audit SHA: `a7251eb236204799bb5421d61cd6c4fb593a9ce9ca87b70bd213578a5d302b62`.
Earlier readiness runs remain failed for indirect formatting, conservative
abort-path fallthrough/recursive codecs, a draft syscall import and a transcript
count error. They were not silently accepted or discarded.

Two further owning runs are terminal FAILED, with evidence preserved.
`run-1d6b40e2-7c67-4a52-b46a-613e29e6f42c` stopped at the newly outlined
private commit's provenance finding. The exact reviewed finding was added;
its public-method mutation remains unreviewed. All four focused provenance
tests pass. `run-8701ef70-3a8a-40b9-85f2-49ddc1d541ef` passed fresh nested
gates, all 48 native tests in 18 inventories, and fresh four-route readiness
`run-bab6720c-df98-430c-94d5-0dfe7a4fc626`, then failed its owning audit:
it treated the sibling runtime smoke summary as a qualification candidate.
The auditor now validates that summary's exact inputs/transcript separately
and uses pinned LLVM archive enumeration to handle BSD symbol indexes while
still requiring exactly one matching host object. A fresh owning rerun is
required; development audit probes cannot retire either failed run.

The next owning rerun `run-231f3833-2a46-4cc9-ad4c-bd5d8274f72b` is terminal
FAILED: identity's composite settlement command hit its 900,000-ms deadline.
Its admission/document/challenge children passed, but the prefix/settlement/v3
and owning run did not complete. No child test processes remain; this was checked
before retry. Composite commands now have increasing subtree budgets, while
native/leaf deadlines and all success/refusal assertions remain unchanged.
Six updated gate scripts transpile; affected tracked diffs pass whitespace checks.
The serial owning rerun `run-6beb98cb-c4db-442d-8dc8-17ac08fb2670` is terminal
FAILED. Admission completed, but document's 37-test native command hit its
900,000-ms leaf deadline. The v9 creation/rollback test itself passed after
518.12 seconds, following a 341.89-second v2 test; later suite stages did not
finish. No own child test processes remained after the failure. No owning
acceptance is established; all failure evidence is preserved.

Native Cargo tests now select `fasttest` at optimization level one with overflow
checks and debug assertions explicitly enabled. Root command environments also
retain debug information and use 256 codegen units, matching the isolated dev-based
exporter profile. SBF/release compilation settings and test assertions stay
unchanged. The per-process native wrapper limits compilation to two jobs.
The first optimized export `run-60731690-7367-4e84-81cc-2e5d31812f74` failed with
ENOSPC; even its first failure JSON write failed. `failure-recovered.json` binds
its retained logs. Disk space subsequently became available without deleting
recorded evidence. Optimized maintained replay is terminal PASSED:
`build/dcg-settlement-sbf-replay/run-b48a14a4-0bab-4f03-965a-2702d9b4293c/`.
Initial optimized dependency compilation took 14m10s; the unchanged fresh native
lifecycle test then passed in 12.73 seconds. All eight SBF executions, two later-
instruction rollbacks and two repeat refusals pass and are independently
reproduced. Terminal recheck binds 345 current inputs and 355 audit paths.
Report SHA: `b03b9317bc8eacebe2930f32dfedff9509a83d23e9b18f87bd335a94d64c3f33`.
Audit SHA: `21504ae489c5f345993341ad575b60f57f9507b691369a32af087cc9cbe55a69`.
Runtime Rust remains unchanged. Earlier qualification receipts remain evidence
for their recorded inputs; profile/harness changes require fresh current checks.

The optimized serial owning rerun was started as
`build/dcg-dispose-executor/run-51fa3382-e6ba-4862-8291-de78555176df`,
exec handle 42903. It is now terminal FAILED as recorded in the latest checkpoint. Host overflow checks/debug assertions remain enabled; the root
command environment matches exporter debug information and codegen settings.

An independently audited development account replay passed for its recorded inputs:
`build/dcg-dispose-executor/development/account-replay-4b6b06d8-c601-4865-9e6b-47e775b04963/replay-report.json`.
Native BDI9/BCH9 setup feeds sequential STANDARD/CUSTOM
132 -> prefix -> 131 -> 172 with no intervening protocol account reset.
All 17 account records match native pre/post states, with only the precise
zero-lamport empty System closure shape normalized to native absence.
Eight executions, two later-instruction rollbacks and two repeat-disposal
refusals pass and are independently reproduced. Current source/export/image/
lock/binary/log bindings and candidate/report/terminal hashes are checked.
Report SHA: `331f097957fcf52633569c1e84157e868b41fad491b2774bd7415410c991c988`.
Audit SHA: `466ac6b6c204462e9051bd3a8dcaa50079dc15120af73dd369aad7573b18c1f6`.
The isolated exporter copies the typed native support alongside the program
and gives copied packages distinct names to avoid Rust crate-identity conflicts;
only package/path wiring, capture helpers and copied test crate references change.
The initial replay and failed harness drafts remain recorded; none is used as
current qualification. This is development evidence, not the maintained owning
sequence gate. Creation, actual CUSTOM callback/fallback, retained cleanup and
capacity remain open. Standard 172 uses 114,531 CU including the budget instruction;
CUSTOM 172 uses 104,899 CU for these recorded cases.

The replay is now a separate maintained command, documented in
`../durable-compute-graph/scripts/bend-settlement-replay/README.md`:
`python3 -B ../durable-compute-graph/scripts/test_bend_settlement_sbf_replay.py <sbf-library-inputs.json> <readiness-report.json>`.
Accepted run: `build/dcg-settlement-sbf-replay/run-a1612a9e-de45-4b1d-93c6-8e6724977802/`.
Fresh native export, eight SBF executions and independent reproduction pass.
At its terminal recheck, the run bound 345 current inputs and 355 audit evidence
paths; candidate and final report were identical. Later native-profile/harness
changes require a new current recheck; this report is evidence for its recorded
inputs. Host and SBF libraries share the same manifests;
native and replay executables are preserved. Report SHA:
`16b117e8999bf502b23ba85b21a7430e87610880a19385676eb9c1be9d55183e`.
Audit SHA: `bdf4d774e07430f56bc80c5a3b516de6d814cfc99dbf2f31b6f1591c65d69568`.
The first maintained run `run-ef96ae6d-43d0-49ca-a5f6-f95a9a3d2392` is FAILED:
the wrapper console log collided with the inner native test log and its digest
check refused publication. Separate log names fix that; failed evidence remains.
This command qualifies the tested local sequence from native BDI9/BCH9 setup;
SBF creation, actual CUSTOM finality, cleanup and capacity remain open.

Next: finish/audit the owning run;
then CUSTOM finality/retained cleanup, complete capacity and broader physical
pending/later-effect/C/SBF assurance. The isolated 17.9% scanner encoder CU gain
remains unpromoted. No fresh broad main npm/full55/client gate ran for these
sibling Rust edits. No agents, commits, deployments, installs or wallet/RPC work.
Earlier cargo-build-sbf probes contain unused private program-keypair files:
never publish/upload those directories. New readiness uses direct Cargo and
creates no such files. All source changes remain uncommitted amid existing work.

## Qualified v3 retained identity — 2026-10-06

Only SHA goal items 1/2 are complete; the full five-item objective remains incomplete.
Local DCG now has a separate v3 IDR3/IDP3 namespace and maintained byte contract,
independent geometry/goldens, live/disposed document readers and immutable
Bend-assigned challenge sequences. BDI9/BCH9/132/prefix/131 use v3; v1/v2 readers
and BDI2 compatibility remain separate. DSO1 can now be independently addressed
and authenticated after DCR1 closes. A private `DispositionPlan` prepares a
once-only 25-byte document-counter witness and checks its preimage; actual 172
must still integrate that write with all result/template/policy/closure effects.
No arbitrary global count cap, retained terminal-policy rent or DCR2 expansion
was introduced. Main unified source/frozen images are unchanged.

Fresh owning command:
`npm exec -- bun ../durable-compute-graph/scripts/test_bend_identity_v3.ts`.
Accepted run: `build/dcg-identity-v3/run-eb8bd0cd-0da7-40c3-8d1c-9bed3b33d420/`.
Two selected private write units and seven synthetic reader tests pass; these do
not establish actual disposal. Fresh nested native creation/opening/132/prefix/
131 passes all 45 tests in sixteen inventories, including DSO authentication
after real DCR1 closure. Pure settlement SBF passes 987 cases. The nested prefix
gate passes 42 native tests and 662 pure SBF cases; these overlapping inventories
must not be added together as unique lifecycle tests. Owning audit binds 240
inputs, six v1 pins and unchanged unified HEAD. Independent terminal audit binds
all eight linked receipts, current inputs, executable/log/artifact/manifest hashes
and final-image depth evidence. Older timeout receipt uses its explicitly checked
candidate-plus-audit-pointer format; other final candidates remain byte-identical.
Report SHA: `3c5333be15867bfe16f6e22858802a1822f121bf3fa2e634e616bb1e35d1bde6`.
Audit SHA: `1525dee614900e03cbf3eacdfaffa1e8ada740ca79ee7604f705fc5ad02ecc7a`.
Terminal check:
`python3 -B build/dcg-identity-v3/development/post-terminal.py build/dcg-identity-v3/run-eb8bd0cd-0da7-40c3-8d1c-9bed3b33d420`.
The first run `run-4fd3853a-7174-4a78-b9ee-8400804ef79d` is preserved FAILED:
its final audit used the wrong repository for a relative compiler-input path.
All jobs are terminal; source freeze is released at this checkpoint.

An isolated, unpromoted bulk canonical integer writer improves all 737 complete
checked scanner cases, with all 1,474 checked/reference SBF outputs matching the
independent oracle. Fixture uploads are independently reconstructed. Largest
matched case: 60,790 -> 49,923 CU (~17.9%); independent Rust remains 8,757.
Rust frame falls 960 -> 896 bytes; final modeled depth remains nine frames.
A compiled U64-truncation control produces four semantic errors while all 737
reference outputs remain unchanged. Separate candidate/control terminal audits
pass. Evidence: `build/dcg-identity-v3/development/bulk-writer-probe-a8cf5f52-4704-4c2c-bd98-58650f7e32b2/`.
Candidate report SHA: `b63554f4c636d3b0fd11c8c94d2ad043282d1224c0510512190d8c3ee4b09b3d`.
This is not maintained-source promotion, account-authenticated 172 or capacity
qualification. No fresh broad npm/full55/client gate ran for these sibling edits.

Next: implement authenticated local 172, scoped result scanning, all-guards-first
atomic writes/closures and directory witness commitment with whole-account
refusal/rollback tests. Real CUSTOM finality, retained rent cleanup, dispatch/
events, complete SBF lifecycle/capacity and broader physical pending/later-effect
assurance remain open. Follow `build/dcg-identity-v3/NEXT.md` for continuation.
No agents, commits, deployments, installs, wallet or RPC work occurred.

## Qualified result-account chunk reader — 2026-10-06

Only SHA goal items 1/2 are complete; the full five-item objective remains incomplete.
The previous turn was a status review and made no implementation progress.
This continuation changes the maintained DCG Rust scanner interface and tests.
`result_scan_call::scan_with` now accepts an authenticated length plus a chunk
reader. Its opaque `ChunkRequest` contains only mechanical offsets from the
private checked cursor. `request.gather(raw, chunk)` copies into the scanner's
owned four-word/32-token arrays; the callback returns before the next Bend call.
An actual account adapter must release extraction borrows before entering and
must release its temporary data guard at callback return, without retaining one
in captured state. The existing slice `scan` delegates to the same core. FINAL
never calls the reader; a read error or changed length aborts before advancing.
No Bend runtime closure, compiler, canonical library ABI, total-output bound,
frozen identity-v1 image or unified dispatcher changed.

Fresh owning command:
`npm exec -- bun ../durable-compute-graph/scripts/test_bend_result_scan.ts`.
Accepted final run:
`build/dcg-result-scan/run-873a1025-c7b2-48fb-8ce4-0b97268edcad/`.
Three maintained linked-Rust tests cover the independent whole-record oracle,
temporary AccountInfo reads over all 737 cases with byte preservation, failures
at every one of nine reads, second-read truncation and no-read FINAL/initial
shape/length refusals. The owning independent audit requires all three named
tests in the actual preserved executable and successful log. This API permits
scoped account reads; it does not authenticate metadata or guarantee that an
arbitrary caller follows its documented guard-lifetime obligation.

The fresh gate and post-terminal audit pass 18 laws/named source fault, 5,787
native/pure-SBF transitions, 737 actual linked-Rust whole-record comparisons and
1,474 complete whole-record SBF outputs. Compiled controls still expose 2,869
bitmap and eight high-word errors. Input/output remain 386/25 bytes and checked
fingerprint remains
`2498476a2fe40519e7a43c16b84dc9a114cf58749f72ed6e552bb021ce171399`.
Bindings cover 135 sources/25 compiler inputs. Library frame remains 1,216;
reported Rust frames are 128 chunk / 960 whole checked / 64 reference. Final
modeled image depths remain 7/9/6. Six v1 pins and frozen unified HEAD match.
Final report SHA:
`49a155dc7acb29a901531602ba824ddc0ea6679dd990570826dd37d24bad5543`.
Independent audit SHA:
`ea5eec6c7cec62033fa1b12b5d4a0d57fed546f2f2f58eda6e3cac85f3b5cb57`.
Post-terminal command:
`python3 -B build/dcg-result-scan-v9/development/post-reader-terminal.py build/dcg-result-scan/run-873a1025-c7b2-48fb-8ce4-0b97268edcad`.

Current matched whole checked/Rust costs: 1 token 9,775/2,325; 32 tokens
11,495/3,085; 33 tokens 16,149/3,129; 128 tokens 30,628/5,497; 257 stop-enabled
**60,790/8,757**; 257 stop-disabled 18,945/3,100; FINAL 5,001/2,226. The new
257-token interface costs 887 CU (~1.5%) more than the preceding 59,903-CU
scanner, though still ~41.6% below the older 104,138-CU indexed fold. Initial
owned-return-buffer runs `run-2c2fe1e2-3e69-41fd-9834-e3a3d3e9a9de` and
`run-7dfcf757-99f2-46dc-9891-79db4654479f` are separately preserved successful
snapshots at 60,985 CU/1,024-byte Rust frame, not current-source receipts. Direct
copy into the scanner's buffer avoids that extra return buffer. Earlier capacity
probe results remain historical evidence for their recorded image, not a fresh
capacity measurement of this interface. Complete-handler capacity is still open.

Cleanup review found two independent retained-witness requirements: terminal
172 closes DPA1 and DCM2, but the fixed 424-byte DCR2 header lacks the settlement
counters required to create DCRZ v3 later; and closing DCR1 in 131 removes the
independently authenticated sequence needed to derive a retained DSO1 address.
The existing directory's v2 entries are explicitly immutable with zero reserved
bytes. They were not repurposed. A local versioned directory/retained-witness
contract must preserve immutable identity and supply those facts before cleanup
can be accepted. Do not retain terminal policy rent, expand DCR2, trust a target's
own seed fields or impose an arbitrary global count cap as a shortcut.

Next: implement/qualify that retained-witness contract, authenticate 172 account
facts and use temporary chunk reads, acquire all write/lamport guards before
atomic exact writes and closures, then rollback and whole-handler capacity tests.
Real CUSTOM finality, retained cleanup, dispatch/events and the complete SBF
account sequence remain required. Broader physical commit/later-effect assurance,
quotient/full55 and ordinary failed-rebuild stale-manifest retirement remain open.
The prior broad npm regression is still the recorded 89-pass/four-ignore result;
it was not rerun for this sibling opt-in Rust reader change. All jobs are terminal
and source freeze is released. No agents, commits, deployments, installations,
wallet or RPC work occurred. Changes remain uncommitted alongside existing work.

## Latest maintained prefix-fold and CU checkpoint — 2026-10-06

Only SHA items 1/2 are complete; the full goal remains active. The generic
`sdk/tree-fold.bend` fold4/fold32 API and maintained test command now pass
5,712 complete Bend/native/SBF outputs, twelve excessive-fuel refusals, three
semantic source controls and an independent manual-wire/integer/native replay
audit. Standalone maximum frame is 1,600 bytes, final depth four frames and
maximum fixture cost 7,298 CU. DCG uses it for tokens only; bitmap/stop/error
rules and canonical sizes 386/25 remain unchanged. Checked closure fingerprint:
`2498476a2fe40519e7a43c16b84dc9a114cf58749f72ed6e552bb021ce171399`.

Accepted owning run:
`build/dcg-result-scan/run-4bdaaedb-1389-438f-968b-ad4c3f64d902/`.
Eighteen laws/named fault, 5,787 native/pure-SBF transitions, 737 linked-Rust
whole cases, 1,474 whole SBF outputs, 135 source/25 compiler bindings, controls
2,869/eight and terminal audits pass. Library frame is 1,216 bytes; Rust frames
128/1,024/64; final depths seven/nine/six. Six frozen v1 pins/unified HEAD match.
Matched 257-token scan costs 59,903 versus 8,757 Rust CU: 42.5% below 104,138.

Capacity-wide closability remains OPEN, with concrete budget failures. An explicit
1.4M transaction budget permits 6,144 stop-enabled outputs at 1,208,435 CU, but
7,168/8,192 exhaust; Rust at 7,168 costs 182,527. At 57,266 both Bend stop-enabled
and stop-disabled scans exhaust. Independent Rust stop-enabled also exhausts;
stop-disabled costs 181,400. This count is the historical width-16 fit boundary,
not fresh admission or current complete-close execution. Sixteen scans, 2,954
successful fixture operations, reconstructed uploads and complete unchanged
post-failure snapshots pass the independent audit in
`capacity-probe-bc9a0eca-f3bc-4b68-9034-046647355b4b` under the development folder.
O3/context-fold probes pass conformance but save only 68/175 CU; neither promoted.

Full `npm test` exits zero. The preserved actual final Rust inventory is 93:
89 pass plus four expected benchmark ignores, including both new tree-fold tests.
Evidence is under `build/tree-fold-qualification/`: `generic-audit.json`,
`regression-audit.json`, `evidence-index.json` and `regression.log`.
All jobs are terminal; source freeze is released. HANDOFF has full paths/hashes,
commands and limitations; earlier sections remain historical snapshots. Next:
measured complete-close capacity contract, authenticated 172 writes/cleanup,
CUSTOM finality/dispatch/full SBF lifecycle, physical/later-effect assurance,
quotient/full55 and generic stale-manifest retirement. No agents, commits,
deployments, installations, wallet or RPC work occurred.

## Latest checked result scanner checkpoint — 2026-10-06

Only SHA items 1/2 are complete; the full goal remains active. DCG now has
`bend/result-scan-v9` and opt-in `bend-result-scan`: Bend derives span and checks
complete bitmap/stop rules; Rust reads bytes using private per-call cursors.
FINAL/decision/stop0 skip the relevant bytes. Sticky stop violations cannot bypass
late malformed bitmap words. The slice uses DCR2 v7's real 424-byte header.
Metadata/account authentication and integration with 172 remain unfinished.

Fresh accepted run and independent/post-terminal audits pass 5,787 complete
native/pure-SBF transitions, 737 actual linked Rust whole-record cases, 1,474
checked/independent-Rust whole SBF outputs, eighteen laws/named law fault and two
compiled controls. 134 source/24 compiler bindings, logs/artifacts/tools, actual
Rust inventory, three final ELF/depth receipts, explicit stack-size checks, six
v1 pins and frozen unified sources pass. Evidence:
`build/dcg-result-scan/run-d246708e-df28-4e16-b53e-194b3dcc56f0/post-terminal-audit.json`.
Library frame 1,232 bytes; checked whole reader reports 1,024 bytes/nine frames.

Capacity-wide closability is OPEN: 257 complete stop-enabled tokens cost 104,138
CU through Bend versus 8,757 in independent Rust, excluding actual account writes.
Do not inherit the old Rust-calibrated close bound. Next measure admitted
capacities and improve the generic path or supply a measured versioned admission
bound before accepting 172. An isolated generic fold probe lowers frame to 960
but worsens this case to 108,262 CU; all 5,787+1,474 outputs match, but it remains
unpromoted under the unique fold-probe directory in HANDOFF.

Next 172 account authentication/scanner integration/writes/cleanup, real CUSTOM
finality, dispatch/events and full SBF account sequence remain required. Full55,
quotient, broader physical-commit/later-effect and generic stale-manifest work
remain open. All jobs are terminal; source freeze released. No agents, commits,
deployments, installations, wallet or RPC work occurred. See HANDOFF/journal for
commands, hashes, scope and preserved developmental failures.

## Latest qualified pure 172 checkpoint — 2026-10-06

Only SHA items 1/2 are complete; the full goal remains active. Checked
`bend/dispose-v9` and its opt-in Rust boundary now pass 2,258 complete
native/linked-Rust/pure-SBF decision cases (1,288 approve / 970 refuse), sixteen
laws plus imported settlement proofs, a named pending-policy law fault and two
compiled economic controls. No-winner STANDARD routing, full-delay CUSTOM
capture, unchanged pending/terminal inputs, template/retention arithmetic and
working-record refunds are covered. Library frame is 2,816 bytes; pure final
ELF is eight modeled frames. Its CU excludes account scanning and execution.

Evidence:
`build/dcg-dispose-decision/run-f258ca8f-0e9d-4460-8b4d-daf57587cb12/post-terminal-audit.json`.
136 sources and 26 compiler/library inputs, full outputs/artifacts/logs, actual
Rust test inventory, six v1 pins and frozen unified sources pass terminal audit.

`scan_verdict` is still a trusted extractor obligation. Complete checked result
scanning, authenticated 172 account extraction/writes/closure, DSO/policy cleanup,
real CUSTOM callback/fallback, dispatcher/events and full SBF account execution
remain required. Next is the checked scanner, then account integration. Preserve
the real 424-byte DCR2 v7 layout and authenticate retained disposed counters.
The generic library builder's stale manifest after a failed same-stem rebuild is
now a preserved assurance follow-up; the fresh accepted gate does not reuse it.
See HANDOFF for scope, hashes, commands and failed development paths.
All jobs are terminal; source freeze is released. No agents, commits, deployments,
installations, wallet or RPC work occurred. Full55/quotient and CU promotion open.

## Latest actual local 131 account checkpoint — 2026-10-06

Only SHA items 1/2 are complete; the whole goal remains active. The opt-in BSS9
adapter now authenticates actual financial/record facts, calls the checked Bend
settlement decision, coalesces recipient aliases, acquires every mutable borrow
before writes, marks DSO1 SETTLED and atomically closes challenge/owned response.
Complete STANDARD/CUSTOM/fallback inputs and immutable rulings remain intact;
System response gifts and existing escrow/finality metadata remain unchanged.
Main dispatch/events and full SBF account execution remain open.

Fresh owning gate and post-terminal audit passed 45 native tests in sixteen
preserved executable inventories, 987 settlement native/linked-Rust/pure-SBF
cases, seventeen laws/named law fault/two economic controls, and every nested
prefix/challenge/document/admission/timeout/transport gate. Six v1 pins and
frozen unified source match. Evidence:
`build/dcg-settle-executor/run-f9cbce7b-733f-4aba-8839-f4d48ba114d8/post-terminal-audit.json`.
224 owning source bindings passed. Both focused account tests passed after
child-only descriptor headroom and controlled bank-fixture corrections.

Next: 172 disposition, retained CUSTOM and DSO/closed-record rent cleanup,
actual custom finality and full SBF account integration. See HANDOFF and
`build/dcg-settle-v9/development/172-next.md` for requirements, scope and commands.
Full55/quotient, broader physical-commit assurance and CU promotion remain open.
The fresh isolated six-operation O3 experiment passed 1,944 sanitizer cases /
5,832 SBF executions but measured zero improvement versus O2; no promotion.
All jobs are terminal; source freeze is released. No agents, commits,
deployments, installations, wallet or RPC work occurred.

## Latest checked local 131 decision — 2026-10-06

Only SHA items 1/2 are complete; the full goal remains active. Checked
`bend/settle-v9` now plans individual bonds, earliest eligible document pot,
alias-aware sequential rent-credit routing, immutable full-delay CUSTOM anchors,
challenge/owned-response refunds and checked counters. Seventeen adjacent laws,
a named recipient-law fault and two compiled economic controls passed.
987 independent integer/manual-wire decisions (337 approvals/650 refusals)
passed sanitizer/native, ordinary linked Rust and the actual pure SBF image.
One Rust test/source/binary inventory is bound and its executable preserved.
Evidence: `build/dcg-settle-decision/run-3f07ccaf-2aff-4f93-a278-5dbc273b1bd4/post-terminal-audit.json`.
124 sources, 23 compiler/library inputs, all artifacts/logs/control outputs,
final ELF/depth receipt, six v1 pins and frozen unified source match.
ABI 399/188; library frame 2,816 bytes; pure image six frames. CU has no matched
Rust baseline and excludes account handlers.

This is a pure decision plus opt-in canonical Rust boundary, NOT the 131 account
executor. Next: authenticated fact extraction, exact financial-role alias grouping,
atomic balance/DSO/doc/policy writes and challenge/owned-response closure, fresh
native-bank payout/rollback controls and actual SBF account execution, then 172
and retained CUSTOM/DSO rent cleanup. Full55/quotient, broader assurance and
CU promotion remain open. All jobs are terminal; source freeze is released.
No agents, commits, deployments, installations, wallet or RPC work occurred.
See HANDOFF/ignored journal for commands, evidence hashes and development failures.

## Latest bounded prefix progress — 2026-10-06

Only SHA items 1/2 are complete; the full goal remains active. Checked
`bend/prefix-v9/` and opt-in BSP9 now validate consecutive paired individual
outcomes, stop at first OPEN and establish pot-winner eligibility strictly after
the prefix passes the best observed win. Eight is a per-transaction window,
never a challenge cap. Only doc winner/policy prefix may change; no lamports,
closures or policy-term changes. Native STANDARD/CUSTOM bank controls and exact
write/rollback checks passed, alongside 662 native/linked-Rust/pure-SBF cases,
eleven laws/named stop-law fault and 42 tests in fourteen executable inventories.
Fresh nested 41/37/35/33-test gates and 391 maintained timeout cases passed.
Evidence: `build/dcg-prefix-executor/run-82373322-4c0f-4d8f-873f-8cc7aff0d169/post-terminal-audit.json`.
196 prefix + 24 compiler/library + 243 transport bindings, six v1 pins and
frozen unified source match. All jobs are terminal; source freeze is released.

Next: checked 131 settlement, then 172 disposal/retained CUSTOM cleanup.
Fresh leaf/other rulings, full SBF account lifecycle, dispatcher/events,
full55/quotient, broader physical-commit assurance and CU promotion remain open.
See the latest HANDOFF and ignored journal for commands, hashes, preserved
oracle/type-law development failures and exact scope.


## Latest fresh position challenge / paired timeout progress — 2026-10-06

Only SHA goal items 1/2 are complete. Checked opening assigns U64 sequences and
BCH9 atomically funds/creates DCR1 v7, individual DSO1 and immutable identity.
BST9 authenticates actual Clock/static manifest and performs paired local 132
writes. Fresh native STANDARD/CUSTOM tests cover full bytes/lamports,
reverse-order earliest observed wins, auth/alias/repeat refusals, strict timeout,
post-write/new-page rollback, U64 boundary and controlled profile-6 identity
restoration/neutralization. Accepted 41 native tests, thirteen executable
inventories, 215 opening native/linked-Rust/pure-SBF cases, fresh nested
37/35/33-test gates and 391 maintained timeout cases/controls:
`build/dcg-challenge-executor/run-7dc1404a-d352-4f5a-af1a-660df328976a/post-terminal-audit.json`.
182 opening + 21 compiler/library + 240 transport bindings, six v1 pins and
frozen unified source match. All jobs are terminal; source freeze is released.

Next: bounded ruled prefix before 131, then 172/retained CUSTOM cleanup.
Fresh leaf/other rulings, full SBF account lifecycle, dispatcher/events,
full55/quotient, broader assurance and CU promotion remain open. Main dispatch
is still unregistered; native bank handlers are distinct from pure SBF decisions.
Detailed evidence/limits are in the latest HANDOFF and ignored journal. Prefix
prerequisite design: `build/dcg-challenge-v9/development/prefix-next.md`.


## Latest revision-9 landing/finalization progress — 2026-10-06

The full goal remains active; only SHA items 1/2 are complete. DCG now has a
separate Bend document lifecycle root and BDP9 local account adapter, with
directory/template/Clock authentication and native STANDARD/CUSTOM landing,
finalization, exact writes and rollback. Twelve laws, the named strict-deadline
fault, 314 independent native/linked-Rust/pure-SBF cases and 37 native tests in
ten checked executable inventories passed. Fresh nested admission (35 tests,
244 decisions) and transport/build/alpha (33 tests) also passed. Post-terminal
source/artifact/log/inventory/v1/unified audit:
`build/dcg-document-executor/run-fbc39786-b933-4b8d-a109-e3e4f363a79a/post-terminal-audit.json`.
Actual SBF account lifecycle and main dispatch registration are not established.

The isolated always-inline CU experiment passed 648 native and 2,592 SBF cases
but exactly matched the previous candidate's CU on every vector. It is not
promoted. All jobs are terminal and the source freeze is released. Next: fresh
challenge/outcome creators with atomic sequences, manifest-aware account facts
and paired 132 execution, then 131/172/cleanup. Full55/quotient, broader assurance
and CU promotion remain open. See the latest HANDOFF and ignored journal for
commands, exact evidence and preserved development failures.

## Latest checked admission and fresh document progress — 2026-10-06

Only SHA items 1/2 are complete; the whole goal remains active. DCG now has a
checked full-policy Bend admission kernel and an opt-in fresh revision-9 document
creator using authenticated facts and the full descriptor. STANDARD/CUSTOM
native bank creation and rollback passed. The fresh gate also passed eleven
Bend laws, a named law fault, 244 independent native/linked-Rust/pure-SBF cases,
35 native tests in eight executable inventories and the nested 33-test transport
gate. Source/log/artifact/executable post-terminal checks and frozen v1/unified
checks passed. Evidence:
`build/dcg-admission-executor/run-9ae34686-7a9d-4364-8e6e-92a4b792af0f/post-terminal-audit.json`.

All jobs are terminal and the gate source freeze is released. Next are actual
revision-9 landing/finalization and challenge/outcome creators with atomic
sequence assignment, then authenticated manifest/Clock extraction and the
paired 132 account executor, followed by 131/172/cleanup. Fresh creator tests
are native bank evidence; SBF execution covers only the pure admission decision.
Main dispatch is unregistered. Full55/quotient, broader assurance and generic
CU promotion remain open. See the latest HANDOFF for commands and preserved
failures; earlier gap descriptions below are historical.

## Latest revision-9 transport progress — 2026-10-06

The full goal remains active; only SHA items 1/2 are complete. DCG now has the
specified full-policy `/6` descriptor codec and a separately decoded revision-9
DRB1 container, plus independently addressed DCM2 v8/ARI1 reading and complete
document/policy-copy checks. All policy reserved bytes now reject corruption.
The new owning `scripts/test_bend_admission.py` passed 33 actual tests, six
executable inventories, vector and supported-build/alpha-separation checks.
Fresh audit: `build/dcg-admission-v9/run-809f2169-5f94-4087-a5ed-561f9dbdd2c0/audit.json`.
Its 223 source bindings, six v1 hashes and frozen revision-8 unified source
remain unchanged. All jobs are terminal; no source freeze remains.

These are transport and read-only record additions, not admission or handler
completion. Next implement Bend policy/template constraints and authenticated
fresh v9 document/policy/challenge/outcome creation with the exact new commitment,
then the actual manifest/Clock extractor and atomic paired 132 executor, followed
by 131/172/cleanup. Full55 and CU promotion remain open. The latest HANDOFF and
ignored journal give scope, preserved failures and exact evidence. The corrected
87-test main Rust regression evidence below remains a distinct source snapshot.


## Latest DCG readiness and regression correction — 2026-10-06

Only goal items 1/2 are complete. DCG now has a separate U64 identity directory,
actual authenticated local compatibility creators and read-only candidate
DCR1/DPA1/DSO1 readers. The arbitrary global v1 directory cap is removed in v2;
v1 remains unchanged. Twenty-five tests, alpha feature exclusion and a fresh
228-binding audit passed. Evidence:
`build/dcg-identity-v2/run-0a10e4be-0756-4eec-bdd6-84e4bcfc602c/audit.json`.
Fresh revision-9 records/creators and the full manifest-aware account extractor
and atomic Bend 132 executor still precede 131/172. Complete policy bytes are
retained; no application-specific compiler or handwritten C business rule was
added.

The broad npm command passed, but its initial Rust step reused a stale one-test
staged executable. A separate fresh Cargo build and source-derived inventory
check passed all 87 regressions with four intentional optional benchmark ignores.
The default cache was then repaired without changing source bytes; ordinary Cargo
also passed the full suite. Both the stale result and an overly strict controller
failure are preserved. Current audited regression snapshot: 958 unchanged
sources, `build/overnight/regression-27f2d05b-d890-48dc-8609-9b6bb88c684d/`
`repaired-regression-audit.json` and `default-cache-audit.json`.
All jobs are terminal; no source freeze remains. Full55 and generic CU promotion
remain open. Consult the latest HANDOFF and ignored journal for exact scope;
older pending-regression and component-only text below is historical.

## Latest integration and DCG canary — 2026-10-06

The complete goal remains active; only SHA items 1/2 are complete. Full
maintained CPI caller/physical integration now has passed three fixtures,
374 raw-query replays and actual native helper/caller faults. The corrected
focused receipt-preservation workflow and its terminal audit passed, with
798 unchanged source bindings and both private component receipts intact.
Session 80863 is terminal 0; the focused source freeze is released. Evidence:
`build/cpi-physical/focused-terminal-audit.json`. The separate
existing caller focused workflow passed; see
`build/cpi-caller/focused-terminal-audit.json`.

DCG now owns a candidate amended record contract and a pure Bend tag-132 core
with frozen ABI/schema goldens, native controls, a separate Python oracle and
391 real mixed Rust/SBF cases. Accepted report:
`build/dcg-timeout-v2/run-8f9af3ec-87c3-4aab-abe5-b048805ae811/report.json`.
It has no account extractor or paired-write handler. Independent uncapped
identity/admission, local bank execution and 131/172 remain open. Full55 and
generic CU promotion remain open. The new isolated CU candidate measures
18.3% improvement versus maintained code, still above Rust.

Broader integrated regression is the next validation step. See the latest
`docs/HANDOFF.md` and ignored journal for scope, live handles and exact evidence.
Older component-only and live-CPI text below is historical.

## Latest maintained CPI component — 2026-10-06

The goal remains active, with only items 1/2 complete. The previously running
isolated CPI connection and strict audit both completed; their evidence remains
conditional and isolated. A new maintained frame component now also models
private helper/syscall workspace and exact descriptor-size writes.
`npm run test:cpi-physical-frame` and its source/artifact audit passed, with
34 raw SMT replays, 96 reconstructed stores, 24 sanitizer scenarios, five helper
faults, SBF layout compilation and 16 report refusals. Evidence:
`build/cpi-physical-frame/focused.json` and
`build/cpi-physical-frame/run-44a4520a-a506-4495-aca0-eeafbfb66de6/terminal-audit.json`.

Next: connect this corrected component to the full caller/count/projection/
physical-commit driver, strengthen maintained report controls and qualify that
integration freshly. DCG amended record/fact reconciliation and local
132 → 131 → 172 remain open, as do quotient/full55 and generic CU promotion.
All jobs are terminal; no source freeze or new pause is active. No agents,
commits, deployments, wallets/RPC or dependency installs were used.
This supersedes the running-CPI text in the historical sections below.

## Latest completed SHA integration — 2026-10-06 UTC

This supersedes the pending replay/regression and historical pause text below.
The complete five-item user goal is active. The first two items are now
integrated and validated: both qualified-library CLI profiles, publication
failure retirement/preservation/restoration, final Rust-linked image gates,
and maintained multiblock checked-source/root identity for 138-byte inputs.

Fresh acceptance: short
`build/sha256-qualified-library/run-40a8ac96-f869-4702-b636-c2bcaaf194f4/report.json`;
packed
`build/sha256-packed-qualified-library/run-1c478b1e-8a12-4681-ac71-e4b284c38185/report.json`.
Their nine controls/profile and final images passed; the independent
publication audit has 197 bindings. Fresh packed identity acceptance passed
31 controls. See the latest SHA documents and `docs/HANDOFF.md` for paths.

Integrated `npm test` passed and was independently audited against 931
unchanged sources in
`build/overnight/regression-fe0d9b24-b3ed-4a8e-9d95-4ccbb4c3e19f/`.
All three CI-ordered client checks and audit passed afterward in
`build/sha-library-integration/client-checks-e90c502a-b26f-49f1-bd78-b0b0c7367e44/`.
Both jobs are terminal 0; `finish.json` passed. The regression/client source
freeze is released; these documentation edits follow the audits.

Remaining: DCG independent identity/current-policy reconciliation and local
132 → 131 → 172 handlers; coherent quotient/full55 repair; broader physical
helper/commit and emitted-C/SBF assurance; generic CU improvements. Native
checked add/sub remains an isolated candidate (6.6% finite-sample improvement
over maintained code, still above independent Rust). Full55 has not passed.
No whole-goal completion is claimed. No agents, commits, deployments, wallet
operations or dependency installations were started.

CPI work is isolated under `build/cpi-physical-connection/`. Its native gate
passed 108 actual generated-caller scenarios and 15 semantic fault controls;
an independent 634-binding audit replayed all 18 sanitizer executables. The
conditional source/helper/physical connection is still running; consult the
latest ignored journal for exact live handles before starting another producer.
Do not edit its bound source files while it runs. Wider U64 address and full
failure-path composition are being prepared and are not maintained proofs.

## Latest publication integration — 2026-10-05

This supersedes the packed-publication pending status below. The maintained
`build:sha256-packed-library` command now uses the common publication lifecycle
with its own checked-source/root catalog. Both profile acceptance runs passed
nine failure/lock controls, prior artifact preservation and real restoration.
Short: 64 sanitizer cases, 65 cases per final Rust/SBF image. Packed: 308
sanitizer cases, 309 per image. Reports are under
`build/sha256-qualified-library/run-0ce542aa-756f-4c39-b21e-a26a03d7f4d2/`
and `build/sha256-packed-qualified-library/run-8586ba79-9214-4746-b159-d51f30131956/`.

The acceptance report accidentally omitted its `profile` field because an
inspection function shadowed the profile argument. That naming issue is fixed,
and source binding now also includes both imported case builders, wire codec,
build support and final-artifact checker. Fresh acceptance replays are required
for those test-source edits. Integrated broad regression and ordered clients
remain pending. Publication receipts always require separate final-ELF checks.

An isolated generic U64 small-operand division candidate passed 648 vectors
across candidate, maintained and independent Rust images (1,944 executions),
but measured 210–222 CU on the small random cases versus maintained 173 and
Rust 128. It was not promoted. Evidence:
`build/sha-packed-publication/small-u64-scout-918de8f5-12aa-4359-b2b2-919b9131ae1a/report.json`.
Other goal items remain intact; no full-goal completion is claimed.

## Latest packed-SHA progress — 2026-10-05

This supersedes the earlier packed-prototype status and next-action recommendation below. The checked SDK reference, generic packed-schema generator, fresh 155-definition source/root identity catalog and explicit `emitSha256PackedQualifiedSbf` are now maintained. Permanent tests passed31 identity/schema/support refusals and restored positives,618 native executions and618 actual LiteSVM executions across ordinary/qualified images. Four compiled semantic mutants and syscall error-after-write trapping were checked. Final image import/stack/artifact/call-depth gates passed. The117-dependency audit is `build/sha-packed-qualification/audit.json`; see `docs/sha256-packed-qualification.md` and latest `docs/HANDOFF.md` for exact inputs and scope.

The138-byte case measured339220 vs2356CU in the same Rust shell (Bend software vs syscall; not an independent Rust baseline or worst-case bound). Packed CLI publication/failure retirement still needs integration and acceptance. The current short-SHA CLI and its catalog remain unchanged. Broad regression for the new addition is pending; the earlier916-source pass applies to its recorded inputs.

Next: integrate packed publication, pass its lifecycle/restoration acceptance and integrated regression, then continue quotient/full55 qualification and the broader roadmap. DCG still needs independently authenticated identity and policy reconciliation before132 →131 →172; new SHA support does not resolve that prerequisite. Fadeno remains paused; no agents, commits, deployments or dependencies were started/installed. No batch jobs remain running; no new user pause or full-goal completion is claimed.

## Current resumed checkpoint — 2026-10-05

The user resumed the goal. This section supersedes the historical pause and first-action recommendations below. Fadeno remains paused; no agents, commits, deployments or dependency installations were started. Existing changes and evidence are preserved.

- Maintained product/carry/tail and relocated division profiles were refreshed and their focused gates passed. See `build/sha-library-integration/main-assurance-audit.json`.
- `build:sha256-library` and `test:sha256-qualified-library` are now maintained commands. The focused acceptance passed seven failure controls, 64 sanitizer cases and 130 actual LiteSVM cases across ordinary/qualified linked images. See `docs/sha256-qualified-library.md` and `build/sha-library-integration/main-feature-audit.json`. Short SHA remains pinned to 0–55 bytes on the reviewed darwin-arm64 tuple; packed multiblock remains a prototype.
- Broad `npm test` passed with exit 0 and no drift in 916 recorded sources. The terminal, log and exact source inventory were independently audited before these final handoff documentation edits: `build/overnight/regression-159a11ae-ad4c-44b2-b59c-fba1eea41801/{terminal,handoff-audit}.json`.
- All three CI-ordered checks passed afterward: `npm exec -- bun tests/program-client.ts`, `npm exec -- bun tests/project-commands.ts`, and `npm exec -- bun tests/client-packaging.ts`. Their logs and 916 source hashes were audited in `build/sha-library-integration/client-checks-27cbff2e-5a2d-40e2-a127-994f9e228d9e/{terminal,handoff-audit}.json`.
- Fresh full55 first failed the old product profile; after its repair it passed eight gates and failed the old quotient profile. Both failed runs and unchanged-source audits are preserved. No current full55 pass exists.
- Current quotient routing, caller, native/two-DIV slices, actual entry-state bindings and 283 VM executions have isolated conditional evidence at `build/sha-library-integration/caller-current-profile/audit.json`. Candidate sources remain under `build/sha-library-integration/worktree`; the generic MUL model addition has not been promoted to main. This evidence does not qualify the maintained quotient gate.
- DCG's eight-hash read-only reconciliation still finds target-derived identity fields and a newer neutral-ruling policy seam. See `build/sha-library-integration/dcg-provenance-reconciliation/report.json`. Independent identity inputs and current policy need review before the 132 → 131 → 172 handler sequence.

Next: compose the current quotient probes with arithmetic/helper theorems, refresh maintained templates, schemas, exact report inventories and meaningful refusal controls, and pass focused qualification before source promotion. Then refresh downstream handler/callframe/zero-fill profiles and rerun full55. Do not treat a rerun of the known-failing aggregate as completion. Physical effects-to-commit and broader translation assurance remain on the requested roadmap.

See the latest `docs/HANDOFF.md` section and `build/overnight/pending-turn-handoff.md` for exact run paths. No known jobs from this validation batch remain running. The old pause below describes the previous session, not a new pause request. Evidence applies to its recorded source hashes; final handoff documentation edits follow the validation audits.

## Historical checkpoint — 2026-10-04

Read this first, then `AGENTS.md`, `README.md`, and the latest section of `docs/HANDOFF.md`. This checkpoint supersedes older pending-state descriptions only for the evidence identified below. Paths are relative to `/Users/colkitt/sith/toys/crypto/bendSVM`.

## User scope and operating constraints

Continue compiler/adapter assurance, actual emitted-C/SBF validation, DCG local integration readiness and generic CU improvements. Connect actual extracted effects through validators, executor preconditions and commit ordering; check helper invalidation. Harden report/artifact bindings and meaningful negatives. Advance DCG handlers 132 → 131 → 172 only after reconciling account-address readiness, preserving policy inputs and frozen deployed images. Validate integrated changes with focused gates, broad regression and full 55-command assurance suite.

The complete active goal text is `/Users/colkitt/.codex/attachments/ce2ebb67-8420-4d74-8238-0c0b2e011df8/pasted-text-1.txt`.

Host session only. Fadeno paused. Do not start agents, commit, deploy or install Lean. Preserve the dirty working tree and ignored evidence. No end-to-end verified compiler or production-readiness claim. Proofs, conditional translation checks, finite testing and runtime assumptions remain distinct.

## Stopped state — clean handoff boundary

The user requested finishing current validation and then pausing. No known work from this session remains running. Do not resume feature work until the user resumes the goal.

- Broad `npm test` **passed**, session61431 terminal0; no drift in905 recorded sources.
- Evidence: `build/overnight/regression-c0781746-4b18-4c15-b590-ca6719ab5766/{terminal,handoff-audit}.json` and `test.log`.
- The log hash and all905 source hashes were independently audited before these final handoff documentation edits.
- Publication controls session61904 terminal0: four actual build failure injections and fresh actual restoration passed. See below.
- No full55 suite was started. It is the first validation task after resumption, using:

```
/opt/homebrew/opt/python@3.14/bin/python3.14 -B build/overnight/run-integrated-all55.py
```

Then audit the completed run with `build/overnight/audit-all55.py RUN_DIRECTORY`. Prior aggregate attempts failed/interrupted; no current integrated full55 pass exists. Do not run concurrent suites that overwrite shared outputs.

## Integrated and focused-qualified

1. CPI custody caller work, source/C conditional scope: full focused workflow passed including fresh restoration, 17 control stages and process failures. `build/cpi-caller-timing/maintained-focused-terminal.json`, `build/cpi-caller/custody-focused-audit.json`. Snapshot predates later SDK integration. Pruning optimization retains structural AST equality; hash collisions cannot authorize membership. No timeout raised.
2. Generic small-divisor wide arithmetic is **already applied** (16 files); do not rerun its apply script. `build/wide-small-divisor-scout/integration/applied.json` and `maintained-audit.json`. Focused gate: 12 API + 15 small-division claims, 15 concrete source faults, four process controls. Full application negatives remain part of final55.
3. Fresh FUTA measurement: `build/futa-maintained-3bb0b8ad-5651-4a0e-b089-8451b40eac27/{measurement,parity,audit}.json`. 45,941 native comparisons and 286 SBF cases/image. u64-max fee 555 vs Rust382 CU; split782 vs593. Fee1 rose7CU relative to old Bend. No FUTA source edits; finite measurements only. See docs/arithmetic.md.

## SHA work: executable evidence, not maintained feature

### Short qualified SHA

`build/mixed-sha-readiness/`: ordinary and source-qualified libraries linked with minimal Rust shell; 64 cases/image in LiteSVM; final ELF checks and four refusal controls. Existing maintained qualification only covers 0..55-byte messages.

### Packed multiblock prototype

`build/sha-multiblock-prototype/`: checked Bend source `bounded.bend`, LAWS/PROOF, generated ordinary library. Packs 160 bytes into 40 U32 words; accepts lengths0..151; canonical input204/output34; ordinary frame1728. Five boundary laws do not prove SHA correctness.

Evidence:
- `native-parity.json`: 309 actual emitted-C ASan/UBSan cases vs Node SHA oracle.
- `execution-audit.json`: same309 ordinary mixed Rust/SBF cases.
- `syscall-audit.json`: same309 syscall-substitution SBF cases; frame704; 138-byte case2354CU versus software339220CU (includes budget instruction); max measured2404CU. Explicit1.4m budget, no worst-case bound.
- `controls/report.json`: exact syscall byte/length/call-count checks; four compiled semantic mutants detected; error after writing digest traps; removing trap detected.
- `identity-controls.json`: 35 literal snapshot-gate refusal controls; unchanged positive accepted.

**Not maintained qualification.** This experiment pins an exact ordinary manifest; it is not the existing checked-runtime identity/catalog mechanism. Do not expose it as a production feature. Next promotion needs maintained generic schema generator, checked source/root identity, reviewed pins, publication lifecycle, controls and integration tests. Existing short API/pins untouched.

### Mixed library publication candidate — lifecycle checks passed

`build/mixed-sha-publication/{publish,build}.ts`: isolated candidate using actual maintained short-SHA qualification and ordinary buildLibrary, separate ordinary host and qualified SBF C/objects, staged immutable generation, archive/retire old active marker and manifest-last publication. Initial real build passed (session79704 terminal0):

`build/mixed-sha-publication/output/active.json`

Generation `1bf62d03-e4dc-4d88-92ba-2cc2869bc634`. Artifact/source audit: `build/overnight/director-checkpoint/publication-audit.json`.

Four actual failed builds were injected after ordinary build, qualified compilation, full build, and immediately before manifest publication. Each refused with its expected error, left no active success marker, preserved the exact prior receipt and artifact bytes, and released the lock. Tests seeded the same previously built active receipt for each refusal. A fresh actual build then restored a new successful generation.

Evidence: `build/mixed-sha-publication/{controls,controls-terminal}.json`; current restored generation is in `output/active.json`. **Still an isolated candidate, not maintained CLI integration.** Final Rust-linked image qualification remains a separate gate. This lifecycle candidate uses existing qualified short SHA; packed multiblock promotion is separate.

## DCG status and remaining roadmap

Local `/Users/colkitt/sith/toys/crypto/durable-compute-graph` still had a contract claiming independent address-provenance gate unmet despite earlier user readiness messages. Reconcile current implementation with contract before handler changes. No DCG source edits. Real closure Merkle parent preimage is138bytes; this motivated SHA extension. Larger records still need authenticated windowed reads/Rust facts. Fact envelope prototypes675/879/954wire bytes are not completed handlers.

Further assurance work includes physical state effects through actual commit (some frame snapshots stop at helper poststate), broader translation coverage, authenticated Rust fact extraction, and integration acceptance. Do not declare the full goal finished based on SHA or CU milestones alone.

## Recovery and navigation

- Extensive append-only journal: `build/overnight/pending-turn-handoff.md` (read tail, not entire history).
- Maintained orientation: `docs/HANDOFF.md`, `docs/refinement.md`, `docs/adapter-assurance.md`, `docs/arithmetic.md`.
- Checkpoint git status/source hashes: `build/overnight/director-checkpoint/`.
- The working tree contains hundreds of changed/untracked paths; no new commit. The full working directory is required. A fresh checkout or git diff alone loses untracked sources and ignored prototypes/evidence. Do not git-clean, reset, or delete build outputs during transfer.
- Use pinned Python above (Z3 5.1.0), npm's Bun, clean pinned `.deps/bend`, Anza v1.53. Follow AGENTS.md; do not bypass toolchain or frame/value bounds.

Recommended first action after explicit resumption: read this checkpoint and source instructions, inspect saved terminal receipts, then run the fresh full55 suite before further maintained integration. No running process needs recovery at this boundary.
