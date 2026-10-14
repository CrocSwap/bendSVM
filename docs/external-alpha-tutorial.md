# External alpha tutorial

This walkthrough changes a collection program's business rule, states the rule
as a Bend law, proves it, and exercises the result as SBF. Run commands from the
repository root after completing [external-alpha.md](external-alpha.md) setup.

## Create a collection project

```sh
npm ci
npm run doctor
npm run bend -- new projects/My-Alpha
```

The starter has a signed owner, a bounded collection of U32 values, and
`Append` and `Replace` instructions. Its `bend.json` lists the `fogo` (SBPFv0)
and `solana` (SBPFv3) targets: `build` and `test` run both, writing
`dist/<target>/program.*` and one shared generated client under `dist/`.
`npm run bootstrap:alpha` installs the Solana toolchain (platform-tools v1.57);
without it, add `--target fogo` to each `build` and `test` command below. The source imports the shared SDK from
this checkout.

## Change the application rule

Open `projects/My-Alpha/program.bend`. Add this helper after `finish`. Bend's
current subset requires a match to inspect a named parameter, so the computed
zero flag is passed into the helper and the match reads `zero`:

```bend
def append_result(zero: Bool, state: State, length: U32, window: C.Window<U32, B.Pair<U32>>, value: U32) -> Outcome:
  match zero:
    case True{}:
      Rejected{4}
    case False{}:
      finish(state, C.push(U32, B.Pair<U32>, 2, storage => index => value => B.pair_set(U32, storage, index, value), window, value), U32.add(length, 1))
```

Then change the `Append` case inside `apply` to call it:

```bend
    case Append{+value}:
      append_result(U32.is_zero(value), state, length, window, value)
```

This rejects zero with application code `4`; nonzero values still use the
starter's bounded `C.push` transition. The `+value` binder permits both the
zero check and the existing append path to use the value. Leave `Replace` as it is.

## State and prove the rule

Add this law to `projects/My-Alpha/LAWS.bend`:

```bend
law zero_append_is_rejected:
  for state: Program.State
  for length: U32
  for window: C.Window<U32, B.Pair<U32>>
  {Program.apply(state, Program.Append{0}, length, window) == Program.Rejected{4} : Program.Outcome}
```

This law specifies `Program.apply` after authorization and collection selection.
Earlier account-level checks may reject with their own application codes.

Then add its proof to `projects/My-Alpha/PROOF.bend`:

```bend
def Laws.zero_append_is_rejected(state, length, window):
  {==}
```

The tutorial helper applies these exact source edits with checked match counts;
its exported `applyFreshDeveloperTutorial(projectDirectory)` function is also
used by the repeatable gate.

## Test successful and rejected transactions

In `projects/My-Alpha/test.ts`, keep the existing nonzero append and replace
checks. Immediately after the existing `before` collection assertions, add:

```ts
await t.reject(client.instructions.Append({value:0},accounts),{application:4});
t.equal(await t.data(accounts.collection),before);
```

The rejected transaction must leave the collection account unchanged. To confirm
the rule is specific to `Append`, also send `Replace({index:1,value:0})`, assert
that the decoded entries become `[17,0]`, then replace the value with `123` again
and compare the account with the saved `after` bytes. The existing successful
appends and replacement continue to check the old behavior. Run the project lifecycle:

```sh
npm run bend -- check projects/My-Alpha
npm run bend -- verify projects/My-Alpha
npm run bend -- build projects/My-Alpha
npm run bend -- test projects/My-Alpha
```

`check` validates the supported subset, storage layout and generated-client
compatibility. `verify` checks the laws declared by this project; it does not
invent specifications or run universal SMT proofs. `build` emits SBF,
interfaces, a manifest and portable clients. `test` executes those clients
against the compiled SBF in LiteSVM and checks the rejection and account
rollback.

## Confirm the law catches a broken implementation

After the positive lifecycle passes, save `program.bend` and change only the
zero branch's `Rejected{4}` to `Rejected{5}`. Keep `LAWS.bend` and `PROOF.bend`
unchanged. Both commands must fail because the implementation no longer
satisfies `zero_append_is_rejected`:

```sh
cp projects/My-Alpha/program.bend /tmp/my-alpha-program.bend
# Edit the zero branch's application code from 4 to 5.
npm run bend -- verify projects/My-Alpha   # expected semantic law failure
npm run bend -- build projects/My-Alpha    # expected semantic law failure
cp /tmp/my-alpha-program.bend projects/My-Alpha/program.bend
```

Restore the source, then rerun `check`, `verify`, `build` and `test`. A semantic
law failure is evidence that the declared source contract is checked. A spawn
failure, signal, missing prerequisite or unrelated build error is not evidence
of that property. This check does not prove the compiler or deployed binary.

## Run the repeatable fresh-developer gate

Run the offline gate:

```sh
npm run acceptance:developer
```

It copies only tracked source files (plus the gate and its helper) into a new
staging tree, excluding generated outputs and key material. It reuses the
installed locked `node_modules`, the clean pinned `.deps/bend` checkout, Cargo
registry/git caches, and Anza platform-tools. The LiteSVM runner is rebuilt with
`--locked --offline` from staged source into a gate-owned Cargo target cache at
`build/fresh-developer-acceptance/runner-target`; the application project and
its build outputs remain fresh in the staging tree. It creates a new project,
applies the rule, runs the successful
project lifecycle, mutates the implementation while leaving its law and proof
intact, and requires semantic failures from both `verify` and `build`. It then
restores the source and repeats `check`, `verify`, `build` and `test`.

The gate removes old success evidence before starting, preserves command logs,
checks that a seeded stale success is removed after a semantic prerequisite
failure, and writes `build/fresh-developer-acceptance/acceptance.json` only
after all offline gates pass. The report hashes the staged source inventory,
project inputs, ELF, manifest, generated clients, test report and gate/helper
inputs. It records reused cache paths and host/tool versions. A clean staged
source tree is not a fresh machine or independent developer run. The report
retains the staged repository and finished project paths so a later local
deployment acceptance step can use the same source and ELF.

The recorded run for this change used macOS arm64, Bun 1.4.2 and Rust 1.92.0.
It passed the offline gate; LiteSVM reported 7 successful transactions, 4
expected rejections and 22 assertions. The resulting ELF was 12,816 bytes with
SHA-256 `f49a704dd7cd30659ffe2a557f035dd68dd7d8de9fe0f9093b900eba4108f471`.
Both mutation commands failed on `zero_append_is_rejected`, with expected
`Rejected{5}` and observed `Rejected{4}`. The full log and hash record is in
`build/fresh-developer-acceptance/acceptance.json` in the validating worktree.

## Run the same project on a local validator

Start a fresh validator using the commands in [local-testing.md](local-testing.md),
then extend the completed offline gate:

```sh
npm run acceptance:developer:local
```

This command checks the retained source, project and artifact hashes before
running the staged project's same `test.ts` through the local RPC backend. It
requires the rebuilt and deployed ELF to match the offline-tested artifact,
and writes `build/fresh-developer-acceptance/local-acceptance.json` only after
the local tests and hash checks pass. The local report links the offline report,
deployed-byte comparison and transaction receipts. If a staged input changed,
rerun `acceptance:developer` first.

For your own project, the reusable command is:

```sh
npm run bend -- test projects/My-Alpha --target fogo --local-rpc http://127.0.0.1:18899
```

The offline command does not submit transactions. Local testing creates fresh
test keys and deploys only to the explicit loopback endpoint; its output directory
contains private test keys and must remain local. Stop your validator when done.
