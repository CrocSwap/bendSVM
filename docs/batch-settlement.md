# Batch-settlement protocol (implementation contract)

Status: accepted in the [container milestone audit](containers-acceptance-audit.md).
The Bend state machine, real-token SBF lifecycle, universal source refinement and
independent Rust baseline pass their tests, proofs and matched benchmark.

A batch records one mint and one to four immutable recipient/amount obligations.
Initialization transfers their checked aggregate from the signer into a designated
custody token account. Settlement transfers every obligation, in order, and closes
the batch atomically. Both operations require the recorded owner's signature.
There is no partial settlement or batch editing. Closed state cannot be reused.

## State and instructions

`State` is `Empty`, `Funded{batch}`, or `Closed`. A funded batch contains:

- owner, mint and exact custody token-account public keys;
- a `Vector<Obligation, Pair<Pair<Obligation>>>`, where an obligation holds a
  recipient owner public key and a positive u64 amount;
- bounded Nat fuel and the checked u64 aggregate.

`Initialize` carries mint, custody account key, vector and fuel. Source validation
requires `1 <= length <= 4`, fuel equal to length, every amount positive, and the
aggregate representable in u64. The actor becomes owner. Inactive backing slots
are ignored by the aggregate and never become transfer obligations.

`Settle` has no caller-supplied recipient, amount or fuel. It uses the immutable
funded state. A generic bounded fold builds one bound transfer per obligation and
checks its aggregate against the stored funded total before accepting.

Source errors: 1 unauthorized; 2 wrong phase; 3 invalid batch, fuel or amounts;
4 aggregate overflow; 5 failed effect construction; 6 inconsistent stored total.
The fold accumulator preserves the distinction between invalid input and
overflow. Adapter/wire/token errors use
the shared SDK's existing error behavior.

## Account contract

The shared state adapter uses account 0 for program-owned state, 1 for the actor,
2 for the original SPL Token Program and 3 for the state-specific custody PDA.
The state allocation is created by the client using the existing signed
initialization workflow; no new PDA-creation instruction is introduced.

| Operation | Additional accounts |
| --- | --- |
| Initialize | 4 actor-owned source token account; 5 designated custody token account; 6 mint |
| Settle | 4 exact stored custody token account; 5 mint; 6 through `5 + length` destination token accounts in obligation order |

Funding binds the destination account key to the recorded custody account.
Settlement binds the source account key to that same key, and each destination's
token owner to the recorded recipient. Mint keys and owners, token-account state,
authority, signer and writable permissions use the shared token adapter checks.
Token-2022 and delegated spending are outside this protocol.

Repeated recipient owners are permitted; account aliases remain subject to the
shared adapter's alias checks. All effects are prevalidated, then invoked in
order. State commits only after all transfers succeed. Any failed CPI rolls back
earlier transfers and leaves the batch funded. Replaying settlement after success
fails on closed state. Extra custody tokens donated outside the protocol do not
increase any obligation or the aggregate transferred.

## Required evidence

The source proof must connect the checked fold to exact active-prefix summation,
overflow/zero-amount rejection, authorization, immutable obligations, ordered
recipient/amount effects, conservation and closing/replay behavior. Mutations must
show that lost obligations, changed recipients, bad totals and weakened guards
fail these claims.

SBF conformance must exercise all batch lengths, funding, settlement, balances,
replay, malformed lengths/fuel, zero and overflow amounts, wrong owners/mints,
wrong custody account, account aliases, insufficient funding and late-CPI rollback.
An independent Rust SBF implementation must pass the same transactions and errors.
Benchmarks must use identical accounts, instructions, token CPIs, toolchain target
and fixtures for both programs, including boundary lengths and rejected requests.

## Current execution evidence

Build with:

```sh
npm run build:program -- examples/batch/PROOF.bend batch.process build/batch
npm run test:batch
npm run verify:batch
```

The shared compiler/adapter produces the program without application C.
Six checked Bend laws cover terminal state, unsigned initialization, failed folds,
conservation rejection and error preservation; four source mutations fail checking.
The separate [source refinement](batch-refinement.md) proves 788 obligations,
including aggregate/ordered-effect behavior, with seven mutation counterexamples
replayed through Bend. The full regression and final evidence audit pass.

The differential fixture compares complete outcomes across Bend, native C and SBF
for 120 cases,
including malformed logical lengths, mismatched fuel, unsigned calls, zero
amounts, overflow and all admitted batch lengths. SBF transaction tests exercise
actual SPL funding/settlement, full-u64 totals, replay, wrong owner/mint/custody,
permissions, aliasing, malformed wire input, stored-total mismatch, donations and
late-CPI rollback. Failed token CPIs preserve their runtime error codes (for
example insufficient funds 1 and frozen account 17 in the pinned runtime).

Batch ELF size is 30,128 bytes. On deterministic fixtures, settlement
costs range from 30,791 CU for one obligation to 76,089 CU for four. These are
measurements from the [matched Rust comparison](batch-benchmark.md). The latest
measurements and fixture hashes are recorded in `build/batch-benchmark.json`.
