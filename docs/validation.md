# Per-application adversarial validation

`tests/validation.rs` runs a common transaction matrix against initialized vault,
vesting and exchange programs, starting with valid withdrawals, claims and fills.
There are 91 cases each for vault and vesting and 141 for exchange (323 total).
Exchange covers both legs and every cross-leg alias pair.

Every case requires the expected SBF custom error and exact preservation of
every passed account and every account from the canonical instruction. This
includes token/mint data, program state, ownership, lamports and metadata. The
fee payer is separate; transaction fees are not expected to roll back.

| Category | Mutations exercised for each application |
| --- | --- |
| Account count | 0, 1, 2, 3, 13; missing effect accounts |
| Instruction | Truncated/extra bytes, invalid mode/tag, nonzero padding |
| Actor | Missing signature and substituted actor |
| State | Readonly, wrong owner, every header byte, incorrect lengths, invalid tag |
| External capability | Wrong token program and custody PDA |
| Aliases | Every pair of account positions |
| Each source/destination | Readonly, wrong program owner, incorrect lengths, wrong mint/authority, uninitialized/invalid state, unsupported native-token encoding |
| Each mint | Wrong owner, incorrect lengths, uninitialized mint, substituted key |

Actor substitution is an application authorization error in vault/vesting. Any
signed taker may fill an exchange offer, so changing the actor while retaining
another user's source tokens instead fails source-authority validation.

After each case the fixture restores the intentionally altered input account.
The original valid operation must then succeed with the expected ledger/token
result. Reports are `build/{vault,vesting,exchange}-validation.json`.

Run after `npm test` has built the programs:

```sh
cargo test --locked --test sbf validation_matrix -- --nocapture
```

This complements initialization, lifecycle, arithmetic-boundary, slippage,
partial/completion, failed-funding, frozen-CPI and cross-program rollback tests.
It is not exhaustive testing of every account byte string or runtime configuration.
