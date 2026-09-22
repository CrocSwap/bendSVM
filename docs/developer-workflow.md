# Write and exercise a Bend program

Use the repository's installed toolchain (see the root README prerequisites).
The commands below need no network after the pinned Bend, Anza and Cargo
dependencies are available. The test runner builds with Cargo's offline mode.
On initial setup with networking, fetch its dependencies using
`cargo fetch --locked --manifest-path scripts/test-runner/Cargo.toml`.

```sh
npm run bend -- new projects/my-program
npm run bend -- check projects/my-program
npm run bend -- verify projects/my-program
npm run bend -- build projects/my-program
npm run bend -- test projects/my-program
```

Creation refuses an existing path. Quote paths containing spaces. The starter
contains an owner-controlled collection, three source laws, their proofs, a
storage layout and a readable TypeScript test. Edit those files; generated C and
wire layouts are build outputs. The template references the shared SDK in this
checkout, so keep that dependency available when moving the source project.

| Command | What it establishes |
| --- | --- |
| `new` | Creates the collection project and tests without overwriting work |
| `check` | Checks declared source laws, target compatibility, storage layout and generated-client compatibility |
| `verify` | Checks the project's declared Bend source laws and their dependencies |
| `build` | Runs checked compilation, emits SBF and clients, checks stack limits, records source/artifact hashes |
| `test` | Rebuilds, then runs the project's `test.ts` against the actual SBF in LiteSVM |

`verify` does not invent specifications or run universal SMT proofs for a new
application. Those proofs need application-specific contracts and verifiers.
Execution tests and source laws are distinct evidence; neither proves the compiler
or a deployed binary. `test` uses no RPC connection and makes no live deployment.

## Generated client

The build writes `dist/program.client.ts`, a bundled runtime and its declarations,
and a self-contained `dist/program.client.js`. Copy the TypeScript client together
with its runtime/declaration files, or copy the JavaScript client alone. Neither
needs the compiler or SDK source at runtime.

```ts
import {createClient} from './dist/program.client.ts';

const client = createClient(programAddress);
const accounts = {state: stateAddress, actor: ownerAddress, collection: recordsAddress};
const instruction = client.instructions.Append({value: 17}, accounts);
```

An instruction has `program`, `accounts` (address/signer/writable) and `data`.
The client derives fixed account order, flags, constructor tags and padding from
the checked interface. A transport submits and signs this instruction; the client
does not hold wallet keys. Addresses are base58 strings, U32 values are numbers,
SDK U64 values are bigint, single-constructor records are field objects, and
multi-constructor values use a `kind` field. Bad fields, values and account aliases
fail before submission. Target validators still enforce their own checks on-chain.

`client.state(bytes)` decodes single-account state. Multi-account clients expose
`client.state.<field>(bytes)`. Collection clients expose
`client.collection(bytes, stateAddress, start, count)`, returning metadata and the
selected typed entries. `client.allocationBytes(capacity)` supplies creation sizes;
omit capacity for programs without a collection.

For token or generic CPI effects, `options.remaining` supplies explicit account
metas. The ABI cannot infer application-specific recipient, mint or callee policy.
These account requirements remain part of the application's client API.

## Offline tests

`test.ts` exports an async function accepting the test context. The generated
starter shows the complete setup; the core flow is:

```ts
const client = createClient(t.program);
const accounts = {
  state: await t.key('state'),
  actor: await t.key('owner'),
  collection: await t.key('records'),
};
const sizes = client.allocationBytes(4096);
await t.createAccounts([
  {address: accounts.state, bytes: sizes.state},
  {address: accounts.collection, bytes: sizes.collection},
], client.instructions.Initialize({}, accounts, {mode: 'initialize'}));

await t.send(client.instructions.Append({value: 17}, accounts));
t.equal(client.collection(await t.data(accounts.collection), accounts.state, 0, 1).entries, [17]);
await t.reject(client.instructions.Replace({index: 1, value: 7}, accounts), 'invalid-selection');
```

The context owns a fresh in-memory runtime, a fee payer and deterministic **test**
signers. `t.key(name)` returns the same address for a reused name within a run.
`t.createAccounts` uses signed system-program instructions and rent-exempt sizes;
its optional instruction runs atomically with creation. `t.send` submits one or
several generated instructions. `t.account` reads account metadata/data and
`t.data` reads required account bytes. `t.equal` asserts decoded results.

`t.reject(instruction, {application: 1})` expects the application's `Rejected{1}`;
numeric runtime codes and `'invalid-selection'` are also accepted. Rejection
assertions compare all instruction accounts before and after, excluding the fee
payer. Errors include transaction logs. Tests must invoke the loaded program and
assert a result; an empty test cannot create a success report.

Only success writes `dist/program.test-report.json`, including transaction logs,
compute measurements, assertions and hashes of the build manifest, test entrypoint,
project configuration and runner inputs. A test attempt with a valid project
configuration removes the prior success report before build setup. These are fixture measurements,
not worst-case compute bounds. The runner does not require user-written Rust or C.

## Existing programs

`bend.json` has `version: 1`, `source` (checked Bend entry module), `root` (exported
transition function), `layout` (storage JSON path, or `null` for the default single
state ABI), and `output` (artifact stem). Source/layout/output paths stay inside
the project. Existing single-account, multi-account and collection programs use
the same commands and generated client. Add a `test.ts` using their instructions.

The supported language and resource bounds still apply; see `subset.md` and
`diagnostics.md`. This workflow adds packaging and testing, not unrestricted Bend
coverage or automatic wallet integration. An explicit
[local-validator test backend](local-testing.md) now deploys a fresh program and
runs the same `test.ts` with `test <project> --local-rpc http://127.0.0.1:18899`.
The default `test <project>` command remains offline.
