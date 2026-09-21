# Constant-product AMM

Status: the local experimental milestone passes its
[acceptance audit](amm-acceptance-audit.md): full regression, source refinements,
reproducible builds and matched Rust SBF measurements. This is a project
self-review, not an independent production security audit.
The [milestone specification](amm-plan.md) defines the completed scope.

## Build and exercise

From the repository root, with the [root prerequisites](../README.md#build-and-test):

```sh
npm ci
npm run build:program -- examples/amm/PROOF.bend amm.process build/amm
npm run test:amm
```

The focused test command checks source-law mutations, validates the TypeScript
client, rebuilds byte-identical artifacts, and executes real SPL Token operations
in LiteSVM. It requires no RPC or wallet. `npm run test:amm-math` separately runs
588 pricing and 111 square-root reference/native/SBF arithmetic cases. The Bend
square-root reference evaluation can take tens of minutes, depending on host
load; the focused lifecycle command does not repeat it.

Read [amm.bend](../examples/amm/amm.bend) for the entire transition,
[pricing.bend](../examples/amm/pricing.bend) for quotes, and
[client.ts](../examples/amm/client.ts) for transaction encoding. All external
effects use [the shared SDK](interfaces.md#custody-controlled-issuance).

## Accounts and preparation

The example client supplies these 12 distinct accounts in this order. Each user
instruction requires the actor's signature; initialization additionally requires
the new state account's signature.

| Index | Account | Writable | Purpose |
| --- | --- | --- | --- |
| 0 | Pool state | Yes | Program-owned allocation of the generated `stateBytes` size |
| 1 | Actor | No | User authorized to spend input tokens or LP tokens |
| 2 | Original SPL Token program | No | Executable `Tokenkeg...` program |
| 3 | Custody PDA | No | Derived from `[b"bend", state_pubkey]` under the AMM program |
| 4 | Actor base token account | Yes | Input or output base tokens |
| 5 | Base reserve token account | Yes | Exact immutable custody account |
| 6 | Base mint | No | First asset mint |
| 7 | Actor quote token account | Yes | Input or output quote tokens |
| 8 | Quote reserve token account | Yes | Exact immutable custody account |
| 9 | Quote mint | No | Second asset mint |
| 10 | Actor LP token account | Yes | Receives new shares or supplies shares to burn |
| 11 | LP mint | Yes | Custody-controlled SPL mint, with no freeze authority |

Create token accounts and initialize the LP mint with standard SPL instructions
before calling the AMM. The asset mints and LP mint must be distinct. Both reserve
accounts must be empty, owned by custody, and have neither delegate nor close
authority at initialization. The LP mint must have zero supply. Its decimals are
an initialization choice (tests use six); the SDK reads the mint's decimals for
checked token operations. All math uses base units, never floating point.

Allocate pool state with a System Program create-account instruction, assigning
ownership to the deployed AMM program. Use `client.stateBytes` from the current
build, not a hardcoded allocation size. Compose that allocation with initialization
in one transaction so failed funding rolls back both. The caller supplies the
state-account keypair signature. The SDK does not create accounts itself.

The three mint addresses and two reserve addresses become immutable configuration.
Actor token accounts may change between calls, provided the caller owns them and
their mints match. A swap uses the two asset groups; the example client includes
LP accounts consistently although the swap's effects do not read them.

## Operations and rounding

- **Initialize:** deposit positive base/quote amounts. Set accounting shares to
  `floor(sqrt(base*quote))`, reserve 1,000 unminted shares permanently, and mint
  the remainder to the actor. Reject zero user shares or a violated `minShares`.
- **Deposit:** request an exact positive number of shares. Pay
  `ceil(reserve*shares/totalShares)` for each asset, within the two maxima, and
  mint the requested shares. Reject reserve or supply overflow before any effect.
- **Withdraw:** burn positive shares and receive
  `floor(reserve*shares/totalShares)` for each asset. Preserve the 1,000 locked
  shares, require positive receipts and both user minima. Burning happens before
  the two reserve transfers; a later failure reverses the burn too.
- **Swap:** choose the input asset and gross input. Fee is
  `ceil(gross*30/10_000)`; effective input is gross minus fee. Output is
  `floor(outputReserve*effective/(inputReserve+effective))`, bounded by the user's
  minimum. Credit the full gross input to recorded reserves. Reject zero effective
  input/output and input-reserve overflow. Fees accrue to liquidity providers.

For example, initializing 10,000 units of each asset gives 9,000 transferable LP
units and 1,000 locked accounting units. A subsequent input of 1,000 base units
pays a fee of 3 and receives 906 quote units. Reserves become 11,000/9,094;
accounting shares stay 10,000. Deposits round up and withdrawals round down.

LP tokens are ordinary transferable SPL tokens. A second wallet can deposit,
receive LP tokens from another holder, and redeem the shares it actually owns.
Voluntary burns outside the AMM decrease SPL supply without changing recorded
accounting shares; the resulting unredeemable stake benefits remaining liquidity.
Unsolicited reserve transfers are surplus, not newly issued shares or a change in
the pricing reserves. There is no admin sweep or governance in this example.

## Client walkthrough

Load the generated schema/interface together. The client returns bytes and
account metadata, leaving signing and submission to your chosen Solana SDK:

```ts
import fs from 'node:fs';
import { ammClient } from './examples/amm/client.ts';

const client = ammClient(
  JSON.parse(fs.readFileSync('build/amm.schema.json', 'utf8')),
  JSON.parse(fs.readFileSync('build/amm.interface.json', 'utf8')),
);
// accounts: AmmAccounts, with each address a 32-byte Uint8Array.
const initial = client.initialize(accounts, 10_000n, 10_000n, 9_000n);
const deposit = client.deposit(accounts, 5_000n, 5_000n, 5_000n);
const swap = client.swap(accounts, true, 1_000n, 906n); // base is input
// Compute fresh withdrawal minima from current reserves before submission.
const withdrawal = client.withdraw(accounts, 1_000n, minBase, minQuote);
```

These are separate operation examples: the swap minimum shown corresponds to the
10,000/10,000 initial pool, not a promise about arbitrary later reserves. Use
`bigint` for all amounts. Obtain user limits from fresh state and your slippage
policy. The caller must provide the deployed program ID when constructing a
transaction, derive custody, and map `address/isSigner/isWritable` to its SDK's
account metadata. The client rejects out-of-range amounts, malformed addresses
and aliased accounts, and returns copied address arrays.

`client.account(bytes)` checks the generated state header and canonical encoding;
`client.reply(bytes)` decodes returned state. Both currently return the shared
codec's constructor/field representation. Follow the generated schema when
reading it; u64 values are `{lo, hi}` limbs and should be combined with bigint.

## Errors, evidence and trust

Application rejections are SDK custom error `256 + code`:

| Code | Meaning |
| --- | --- |
| 1 | Actor did not sign |
| 2 | Wrong lifecycle instruction, including repeated initialization |
| 3 | Invalid initial configuration or zero initial asset amount |
| 4 | Arithmetic failure, zero usable shares, or invalid/zero quote |
| 5 | User maximum/minimum violated |
| 6 | Withdrawal would violate locked liquidity or has zero shares |

The adapter additionally validates storage ownership, encoding, aliases and
custody. Token errors include bound-address and initial-custody checks described
in [interfaces.md](interfaces.md). SPL failures such as frozen accounts or
insufficient token balances also reject and roll back the transaction.

Current lifecycle tests cover two providers, transferable shares, bidirectional
swaps, exhaustion of circulating shares, re-deposit after exhaustion, slippage,
unsigned operations, initialization limits, substituted reserves, failed funding,
late withdrawal failure after a successful burn and transfer, and rollback across
multiple instructions, full-width liquidity/overflow, and donations/external
LP burns. TypeScript client vectors are checked against an
independent Rust encoder and executed in SBF.

The Bend laws cover local rejection helpers, unsigned calls and repeated
initialization. Checked-source square-root and pricing refinements establish
initial-share arithmetic, fee bounds, quote rounding and the swap product
inequality. The complete transition refinement checks authorization, accounting
updates, immutable configuration and exact token-effect construction.
Run `npm run verify:sqrt`, `npm run verify:amm-pricing`, and `npm run verify:amm`;
[refinement.md](refinement.md) explains their bindings and assumptions.

The [Rust comparison](amm-benchmark.md) describes complete-program measurements,
including account validation and real SPL Token CPIs. The completed regression and source review are recorded in the
[acceptance audit](amm-acceptance-audit.md).
Source proofs do not establish correctness of the compiler, LLVM, runtime or SPL
Token program. Original SPL Token only; no Token-2022, transfer fees, wrapped SOL
or delegated spending.
