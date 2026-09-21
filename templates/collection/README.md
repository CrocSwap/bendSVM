# Bend collection project

This starter stores U32 records in a separate account controlled by a signed owner.
You edit `program.bend` for behavior, `LAWS.bend` for specifications, `PROOF.bend`
for their proofs, and `test.ts` for execution tests. Generated C is a build artifact;
you do not need to edit it.

From the bendSVM tool checkout:

```sh
npm run bend -- check @PROJECT@
npm run bend -- verify @PROJECT@
npm run bend -- build @PROJECT@
npm run bend -- test @PROJECT@
```

`check` checks the source, admitted language subset, account layout and client
compatibility. `verify` checks declared source laws. `build` also checks the SBF
toolchain's stack limits and writes `dist/program.so`, clients and resource reports.
`test` rebuilds and executes `test.ts` against the compiled SBF in LiteSVM, without
a network connection. It does not deploy through Solana RPC.

Import `createClient` from `dist/program.client.ts` (or the portable `.js` file).
Calls such as `client.instructions.Append({value:17}, accounts)` produce transaction
instructions with the correct account order, flags and encoding. Use
`client.allocationBytes(capacity)` for sizes and `client.state(...)` /
`client.collection(...)` for decoding. Addresses are base58 strings; SDK U64 values
use bigint. You never supply constructor tags or wire padding.

The test context supplies named test signers, creates accounts, submits generated
instructions, reads account data and compares decoded results. `t.reject` checks
the expected error and unchanged application accounts; transaction fees are excluded.
Successful tests write `dist/program.test-report.json`. Starting a test with valid
project configuration removes the previous success report. Test keys are deterministic fixtures, never wallets
for a live cluster.

Source laws cover only their stated properties. This command does not automatically
prove arbitrary application invariants, the compiler, or a deployed binary. The
default ABI permits append/replacement with bounded windows, without account
resizing or truncation. Broader application-specific SMT proofs are a separate step.
