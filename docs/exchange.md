# Fixed-price offer exchange

`examples/exchange/` implements funded sell offers using the same compiler,
storage adapter, checked arithmetic and token-effect executor as the vault and
vesting applications. It supplies no C and adds no application-specific
compiler or SDK branches.

An offer stores its maker, base/quote mints, remaining base quantity and positive
price numerator/denominator. Creation requires distinct mints, positive quantity
and nonzero price terms. It validates both mints and transfers the entire offered
quantity from the signing maker into a state-specific custody PDA. Creation,
funding and initial state storage can be one atomic transaction.

A signed taker submits `Fill { amount, max_payment }`. The contract requires a
positive amount no larger than the remaining quantity and computes:

```text
quote payment = ceil(base amount × numerator / denominator)
```

Prices are ratios of token base units. Mint decimals are checked by the Token
Program but do not rescale the ratio. The multiplication has full 128-bit
precision; an unrepresentable u64 payment is rejected. Payment must be positive
and no greater than the taker's maximum.

Rounding occurs per fill, in the maker's favor. Splitting a fill may therefore
cost more: at a price of 2/3, buying three units together costs two quote units,
while buying one and then two costs three. Clients should compute the desired
fill and set its maximum explicitly. The offer price is immutable.

The first transfer pays quote tokens from the taker to a token account owned by
the stored maker. The second transfers base tokens from custody to the taker.
Both effects validate their expected mints, authorities and recipients. If either
CPI fails, neither transfer nor the remaining-quantity update persists.

The maker can cancel an open offer and recover its unsold base quantity. A full
fill or cancellation produces `Closed`, which rejects all subsequent calls.
This version has no orderbook, AMM, matching engine, fees, expiry or account
closure/rent reclamation. Unsolicited custody donations do not increase the
recorded offer quantity or cancellation refund.

## Build and interface

```sh
npm run build:program -- examples/exchange/PROOF.bend exchange.process build/exchange
```

The command checks proofs, emits codecs and the shared adapter, compiles SBF and
writes a source/artifact manifest. `npm test` runs the complete test suite.

The generated schema/interface files describe a 148-byte state account and
95-byte canonical instruction in this version. Instructions are:

- `Initialize { base, quote, amount, numerator, denominator }`
- `Fill { amount, max_payment }`
- `Cancel {}`

Every account list starts `[state, actor, tokenProgram, custody]`. Additional
accounts, in order, are:

| Operation | Actor | Remaining accounts |
| --- | --- | --- |
| Initialize | Maker | Maker base token, custody base token, base mint, quote mint |
| Fill | Taker | Taker quote token, maker quote token, quote mint, custody base token, taker base token, base mint |
| Cancel | Maker | Custody base token, maker base token, base mint |

The state address must sign initialization. All accounts within an instruction
must be distinct. Use `sdk/storage.ts` and the generated JSON interface for
encoding; see [interfaces.md](interfaces.md) for the shared account/CPI contract.

Application errors after the adapter's +256 mapping are 257 unauthorized,
258 uninitialized operation, 259 invalid offer, 260 invalid fill quantity,
261 slippage/zero-payment rejection, 262 price arithmetic failure, 263 closed
offer and 264 reinitialization through a normal transition.

## Evidence and trust boundary

Five checked laws cover quantity/slippage rejection guards, unsigned fills,
unsigned cancellations and the terminal closed state. Five mutations, including
bypassing the main fill/cancellation authorization, fail proof checking. These
are specific source properties; they are not a complete economic conservation
or compiler-correctness proof.

Seventy-two independent pricing vectors compare BigInt, Bend evaluation,
generated native C under sanitizers and SBF. Transaction tests create real mints
and token accounts and cover partial/full fills, explicit rounding, slippage,
cancellation, unauthorized calls, invalid offers, failed funding, malformed
inputs, wrong owner/mint/recipient, account aliases, full-width prices and
overflow. A frozen base recipient causes the second CPI to fail after the quote
transfer succeeds; the test checks logs for both events and verifies rollback
of every tracked state/token/mint account.

A cross-application test deploys all three generated programs into one LiteSVM:

1. Purchase base tokens and deposit them into the vault in one transaction.
2. Withdraw from the vault and fund a vesting schedule in one transaction.
3. Complete the vesting claim and verify the total base-token supply is accounted
   for across all three programs' custody/user accounts.

An oversized vault deposit also verifies rollback of a preceding successful
exchange fill. This establishes transaction-level composition of the common
interfaces. The separate [bounded generic CPI SDK](cpi.md) also has SBF integration coverage.

The current exchange ELF is 30,688 bytes. One lifecycle measurement used at most
47,777 CU; PDA search cost varies with addresses, so this is not a worst-case
bound. Latest measurements are in `build/exchange-metrics.json`.

`npm run verify:exchange` now checks all nine entrypoint state/instruction cases,
exact funding/refund/settlement effects, inventory conservation and per-fill
ceiling-price bounds. It binds imported ceiling arithmetic to its checked proof
and rejects six source mutations with concrete Bend witnesses. See
[refinement.md](refinement.md) for the compositional SMT assumptions. Actual CPI
execution, rollback and compiled-machine behavior remain separately tested.
