# Funded linear vesting

`examples/vesting/` implements a fixed, fully funded vesting schedule in ordinary
Bend. It uses the same compiler, storage adapter, clock context, PDA custody and
token-effect executor as the vault, with no application-specific backend or C.

Initialization names a beneficiary, mint, total allocation and start/end slots.
It requires `total > 0` and `start < end`, then transfers the complete allocation
from the signing funder to the state's custody PDA. Account creation, funding
and schedule storage can be one transaction; any failure rolls everything back.
The beneficiary can differ from the funder.

The signing beneficiary claims according to the runtime Clock slot:

```text
now <= start:  vested = 0
now >= end:    vested = total
otherwise:    vested = floor(total × (now - start) / (end - start))
payout = vested - previously_claimed
```

The product uses the shared full-precision multiply/divide API, so a u64 total
and u64 duration do not require their product to fit in u64. Each claim pays all
currently available entitlement. Rounding is cumulative: splitting claims does
not accumulate rounding error, and the final claim releases the entire remaining
allocation. For seven tokens over three slots, cumulative payouts are 2, 4, 7.

The contract rejects zero payouts, backwards entitlement relative to an earlier
claim, and an entitlement above the stored total. It checks the beneficiary's
runtime signature and full public key. The executor independently requires the
destination token account to belong to that stored beneficiary and to use the
stored mint. Frozen accounts and other Token Program failures roll back both
the transfer and the update to claimed entitlement.

Schedules are immutable and use slots, not wall-clock seconds. This version has
no cancellation, top-ups, beneficiary changes or account closure. Funds are
deposited completely during initialization, not promised for later funding.

## Build and interface

`npm test` builds the application and runs its full transaction tests. To build
the application after installing the project's pinned dependencies:

```sh
npx --no-install bun compiler/cli.ts examples/vesting/PROOF.bend vesting.process build/vesting.h --storage
npx --no-install bun -e 'import {compileSbf} from "./scripts/build.ts"; compileSbf("build/vesting.c", "build/vesting");'
```

`build/vesting.schema.json` and `build/vesting.interface.json` describe the
canonical interface for `sdk/storage.ts`. Initialization takes
`Initialize { beneficiary, mint, total, start, end }`; later calls take `Claim {}`.
State accounts are 124 bytes and instructions 95 bytes in this version, including
their headers/tags/padding. Clients should use the generated metadata.

Both operations use `[state, actor, tokenProgram, custody, sourceToken,
destinationToken, mint]`. Initialization's actor/source are the funder and its
token account; the destination belongs to custody. Claim's actor is the
beneficiary, source belongs to custody and destination belongs to the beneficiary.
The state address must sign initialization. See [interfaces.md](interfaces.md)
for custody derivation, account requirements and adapter error codes.

Application errors after the adapter's +256 mapping are: 257 unauthorized,
258 claim on uninitialized state, 259 invalid schedule, 260 arithmetic or
entitlement-cap failure, 261 entitlement regression/underflow, 262 nothing to
claim, 263 reinitialization through an ordinary transition.

## Evidence and assurance boundary

Four checked laws cover invalid-schedule rejection, the entitlement cap guard,
the zero-payout guard and unsigned calls through the main claim transition. Four
mutations must fail the proof gate. These properties do not constitute a full
proof of linear vesting or of the adapter's token-transfer behavior.

Seventy entitlement vectors compare an independent BigInt model with Bend
evaluation, generated native C under ASan/UBSan and SBF. The wide arithmetic has
another 410 oracle cases. Transaction tests cover actual funding, a distinct
beneficiary, start/end boundaries, partial/repeated/completed claims, cumulative
rounding, u64::MAX amounts and long schedules, invalid schedules, insufficient
funding, malformed instruction padding, account aliases/ownership, unauthorized
calls, incorrect recipients, frozen-token rollback and time regression.

The initial lifecycle run produced a 28,816-byte ELF and a measured maximum
27,934 CU. PDA search cost varies with addresses; this is a sample, not a
worst-case guarantee. Current measurements are written to
`build/vesting-metrics.json`. Arithmetic and source-transition refinement are
covered by the commands below; transaction-level composition is exercised with
the vault and exchange. Compiler/adapter correctness remains a trust assumption.

The separate `npm run verify:vesting` command now checks exact funding and payout
accounting universally over checked source terms. Accepted payouts preserve the
schedule, increase claimed by exactly the requested custody transfer and keep it
at most the funded total. Four mutations produce counterexamples replayed through
Bend. `npm run verify:vesting-process` connects these results to timed entitlement
and every state/instruction case of the authorized entrypoint, after checking
that imported arithmetic matches its proved definitions. See
[refinement.md](refinement.md) for the compositional SMT trust boundary. The
adapter/CPI path remains tested rather than formally verified.
