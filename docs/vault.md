# Single-owner token vault

`examples/vault/` is the first complete application lifecycle on the shared
compiler/storage/effects path. All authorization, instruction handling and
balance updates are ordinary checked Bend. The compiler contains no vault
branches, and no application C is supplied.

The vault stores an owner key, mint key and checked u64 deposited balance. It
supports:

1. Initialize an all-zero, program-owned state allocation, with signatures from
   the state address and owner. Validate the mint and start with zero accounting.
2. Deposit from the signing owner's token account into a token account owned by
   the state-specific custody PDA. Checked addition rejects ledger overflow.
3. Withdraw from custody to the signing owner's token account. Checked
   subtraction rejects requests above the deposited balance.

This is a single-owner vault, not a share-issuing pool. Unsolicited token donations
do not increase its recorded deposited balance. It has no close, recovery,
delegate, rent-reclamation or upgrade/migration interface yet.

## Build and run

```sh
npm ci
npm test
```

The test command builds `build/vault.so` and executes signed LiteSVM transactions.
It creates a real mint and token accounts with System/Token instructions, mints
test tokens, then exercises the vault. No public network or wallet is used.

To regenerate just the application after dependencies are installed:

```sh
npx --no-install bun compiler/cli.ts examples/vault/PROOF.bend vault.process build/vault.h --storage
npx --no-install bun -e 'import {compileSbf} from "./scripts/build.ts"; compileSbf("build/vault.c", "build/vault");'
```

The output includes canonical types/codecs, `.schema.json`, `.interface.json`,
generated adapter C and the SBF ELF. `sdk/storage.ts` consumes the JSON interfaces
to encode instructions and decode stored state. See [interfaces.md](interfaces.md)
for the wire format and custody execution contract.

Accounts start with `[state, owner, tokenProgram, custody]`. Initialization adds
the mint at index 4. Deposit/withdrawal add `[sourceToken, destinationToken, mint]`
at indices 4, 5 and 6. Custody is derived from `[b"bend", state_pubkey]` under the
vault program. All accounts must be distinct. Instruction constructors are
`Initialize { mint }`, `Deposit { amount }` and `Withdraw { amount }`.

The stored account is 96 bytes: 20-byte schema header, `Live` tag, encoded owner
and mint keys (33 bytes each), and encoded u64 balance (9 bytes). Generated
interfaces are authoritative; clients should not hardcode these offsets.

Application errors, after the adapter's +256 mapping: 257 unauthorized,
258 uninitialized transition, 259 reinitialization through a normal transition,
260 deposit overflow, 261 excessive withdrawal. Adapter initialization mode
rejects an already initialized allocation with runtime error 4.

## Evidence and limits

`tests/vault_sbf.rs` checks full initialization/deposit/partial withdrawal/full
withdrawal, zero amounts, u64::MAX balances, overflow/underflow, unsigned and
wrong-owner calls, wrong custody/token program, recipient/mint/token-owner
validation, aliases, writable permissions, bad initialization, insufficient
actual token funds and frozen-token CPI rollback. A separate ordinary Bend
fixture, `tests/settlement.bend`, exercises successful two-leg execution and
rollback after the second CPI fails. That probe intentionally accepts caller-
chosen effects and is not a deployable custody application.

Five vault laws prove unsigned initialization/live calls are rejected, the
authorization helper rejects a false guard, and arithmetic errors reject
deposits/withdrawals. Four mutated implementations must fail proof checking,
including bypassing authorization in the main transition. These are specific
source properties, not a full conservation/refinement proof. Separate SMT commands cover arithmetic and full source-transition refinement;
the compiler/SDK trust boundary remains explicit. See [arithmetic.md](arithmetic.md).

An earlier full test run produced a 16,840-byte ELF and a maximum 24,706 CU in
the measured vault lifecycle (including account creation when present). PDA
bump-search cost varies with generated addresses; this is a sample measurement,
not a worst-case bound. The pinned LiteSVM runtime bundles original SPL Token
3.5.0; host tests use SPL Token 8.0.0 instruction constructors for the compatible
operations used here. The program remains SBPFv0.

`npm run verify:vault` now universally checks the complete source entrypoint,
including all six state/instruction cases, signature/owner checks, exact balance
changes and token-effect descriptions. Two 65-bit equations establish deposit/
withdrawal conservation, and five source mutations yield counterexamples replayed
in Bend. See [refinement.md](refinement.md) for assumptions: actual CPI and atomic
state commit remain tested adapter/runtime behavior, not formally proved behavior.
