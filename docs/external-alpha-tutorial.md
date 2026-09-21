# External alpha tutorial

This tutorial starts with a new project, changes it, observes a declared
source-law failure, and executes the repaired project as SBF. Run commands from
the repository root after [external-alpha.md](external-alpha.md) setup.

## 1. Create and inspect a starter

```sh
npm ci
npm run doctor
npm run bend -- new "projects/My Alpha"
```

The starter contains `program.bend`, `LAWS.bend`, `PROOF.bend`, `storage.json`
and `test.ts`. It imports the SDK source from this checkout, while its generated
clients and SBF remain in the project `dist/` directory.

## 2. Modify the behavior and run the checks

For a harmless first change, edit `projects/My Alpha/test.ts` and change the
third appended fixture and matching expected entry from `99` to `77`. Then run:

```sh
npm run bend -- check "projects/My Alpha"
npm run bend -- verify "projects/My Alpha"
npm run bend -- build "projects/My Alpha"
npm run bend -- test "projects/My Alpha"
```

`check` validates the supported subset, storage layout and generated-client
compatibility. `verify` checks the laws actually declared by this project;
it does not invent specifications or run universal SMT proofs. `build` emits
SBF, interfaces, a manifest and portable clients. `test` invokes those clients
against the compiled SBF in LiteSVM and checks successful and rejected
transactions, including unchanged application accounts on rejection.

## 3. See a source-law failure

Make an intentionally invalid implementation change while leaving its laws and
proofs unchanged. Save the original file first:

```sh
cp "projects/My Alpha/program.bend" /tmp/bend-alpha-program.bend
sed -i.bak 's/Rejected{1}/Rejected{4}/g' "projects/My Alpha/program.bend"
npm run bend -- verify "projects/My Alpha"   # expected: non-zero
npm run bend -- build "projects/My Alpha"    # expected: non-zero
mv /tmp/bend-alpha-program.bend "projects/My Alpha/program.bend"
rm -f "projects/My Alpha/program.bend.bak"
```

The failure is evidence that the declared source contract is checked. It is not
evidence that the compiler or deployed program is formally verified. A proof
hole in `PROOF.bend` is a separate expected failure mode.

## 4. Rebuild and exercise SBF

```sh
npm run bend -- check "projects/My Alpha"
npm run bend -- verify "projects/My Alpha"
npm run bend -- build "projects/My Alpha"
npm run bend -- test "projects/My Alpha"
```

Inspect `projects/My Alpha/dist/program.test-report.json` and the manifest. The
report is a local fixture measurement, not a worst-case compute bound. The
generated client constructs account order, signer/writable flags and canonical
bytes; the test context supplies deterministic test keys. No configured wallet,
RPC endpoint or manual Rust/C instruction encoding is involved.

## 5. Use the generated client

The portable JavaScript client can be copied with its runtime, or the typed
TypeScript client can be used with its runtime declaration. A transport must
turn the plan into a signed transaction:

```ts
import {createClient} from './dist/program.client.js';

const client=createClient(programAddress);
const instruction=client.instructions.Append({value:17}, {
  state:stateAddress,
  actor:ownerAddress,
  collection:collectionAddress,
});
// Sign and submit `instruction` with the wallet/RPC transport of your choice.
```

Do not hand-copy tags, padding or account offsets. For token/CPI programs, pass
the policy-specific `remaining` account metas explicitly. The queue deployment
example exercises this generated-client path in its live harness; a reusable
wallet/RPC transport is not yet part of the alpha.

## 6. Run the repeatable gate

```sh
npm run acceptance:alpha
```

The gate creates a new staging directory under `build/external-alpha/`, runs
the full starter lifecycle, deliberately checks the invalid-law path, and writes
`build/external-alpha/acceptance.json`. It starts with an empty staged project
and never copies the repository's existing application ELF/client outputs.
