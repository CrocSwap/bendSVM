# Historical escrow POC snapshot

This preserves the earlier README and its escrow-specific measurements. Progress
statements below are historical; see the current [README](../README.md) and
[acceptance audit](acceptance-audit.md) for the current milestone.

# bendSVM

A working proof of concept for compiling a restricted subset of **Bend 2** to
Solana SBF. Bend checks the implementation and proofs; a small backend translates
the checked terms to freestanding C; Anza Clang/LLD produce an ELF that executes
in LiteSVM using signed Solana transactions.

Development is extending this into a shared compiler and SDK for a vault,
vesting contract and small exchange. See the [implementation plan](implementation-plan.md)
for the full acceptance criteria and remaining work. The shared
[arithmetic library](arithmetic.md) now provides checked u64 operations;
the supported subset is documented in [subset.md](subset.md). The
[vault](vault.md) now initializes, deposits and withdraws real test tokens
through shared PDA custody and token CPI. Generated
[interfaces and storage](interfaces.md) now provide canonical codecs,
signed initialization, runtime actor/clock context and atomic state updates.
The [vesting contract](vesting.md) now funds a schedule atomically and makes
beneficiary claims using the runtime slot and full-precision multiply/divide.
The [exchange](exchange.md) supports funded fixed-price offers, partial fills,
slippage limits, cancellation and atomic two-token settlement. Integration tests
compose purchases, vault deposits/withdrawals and vesting funding across programs.
Additional [arithmetic refinement commands](refinement.md) check u64
arithmetic and full-precision multiply/divide with Z3 using compositional proofs.
The shared [validation matrix](validation.md)
exercises 323 adversarial transactions across the three applications.

The example is an escrow **ledger state transition**, not a token transfer:
`Locked(amount) → Released(amount)` when the stored authority signs. Amounts span
the full unsigned 64-bit range using two `U32` limbs. No amount arithmetic is
needed for this example.

## Run

Prerequisites:

- Node/npm and Git. `npm ci` installs the pinned Bun 1.4.2 runner.
- Rust/Cargo (tested with Rust 1.92.0) for the host-side LiteSVM tests.
- A host Clang in `PATH` for native differential tests (`CC` overrides it).
- [Anza platform-tools v1.53](https://github.com/anza-xyz/platform-tools/releases/tag/v1.53).
  The build uses `~/.cache/solana/v1.53/platform-tools/llvm/bin` by default.
  Set `SBF_TOOLS` to another installation's `llvm/bin` directory if needed.

```sh
npm ci
npm test
```

The first build fetches Bend commit
`7561656155a4285c1e4ccfcb3505ab59524de973` into `.deps/bend`; later builds require
that checkout to remain clean and pinned. The first Cargo build can take several
minutes. No wallet, validator process, RPC endpoint or deployment is needed.

To build without running the tests:

```sh
npm run build
```

Build any application independently with its checked source and export root:

```sh
npm run build:program -- examples/exchange/PROOF.bend exchange.process build/exchange
```

This emits the SBF ELF, generated interfaces and a source/artifact manifest.

To invoke the backend directly after the dependency has been fetched:

```sh
npx --no-install bun compiler/cli.ts examples/escrow/PROOF.bend escrow.release build/custom.h
```

This targets **SBPFv0** (`--target=sbf -mcpu=generic`, ELF flags `0`), explicitly
chosen for the pinned LiteSVM 0.7.1 / Agave 2.3 test environment. It does not use
the default `cargo-build-sbf` toolchain and does not establish SBPFv3 support.

## Results

Measured locally on 2026-09-20:

| Check | Result |
| --- | --- |
| Bend laws | Four checked proofs |
| SBF ELF | 2,688 bytes |
| Successful release, including adapter and return-data syscall | 1,161 CU |
| Bend reference / generated native C / SBF agreement | 128 cases |
| Negative proof and backend cases | 11 rejected as expected |
| Account validation and repeat-release tests | Passed |
| Heap allocation / mutable program globals | None |

The 128 cases cover 32 amounts × both states × both authorization values.
Amounts include `0`, `2^32`, `2^63` and `u64::MAX`, plus deterministic random
values. Unauthorized cases preserve state in the pure model and fail atomically
with error 7 in the Solana adapter. The measured CU figure is for this small
example in the pinned runtime, not a general Bend performance result.

## Proofs and compilation

[`LAWS.bend`](../examples/escrow/LAWS.bend) specifies:

1. Release preserves the exact amount.
2. Unauthorized release leaves the state unchanged.
3. Authorized release changes a locked state into a released state.
4. Releasing twice has the same effect as releasing once.

[`PROOF.bend`](../examples/escrow/PROOF.bend) supplies proofs by case analysis.
`npm test` mutates the implementation to violate these laws and requires the
checker to reject the mutations. It also rejects open laws, proof holes, unsafe
dependencies, bypassed law imports and unsupported runtime features.

[`compiler/backend.ts`](../compiler/backend.ts) consumes `Def.e`, Bend's checked
elaboration. It uses explicit export roots and emits only their runtime call
closure. The proof definitions never enter the generated C. It does not parse a
separate imitation of Bend or substitute a handwritten implementation of the
escrow function. A second checked fixture exercises field permutation, nested
calls, local bindings and literals independently of the escrow example.

The supported runtime subset is deliberately small:

- Pinned Base `U32` literals/values, `Bool`, and the arithmetic/Boolean operations
  specified in [arithmetic.md](arithmetic.md).
- Concrete, nonrecursive records and tagged unions with supported fields.
- First-order, fully applied, nonrecursive calls, constructor matching and
  ordinary expression-local bindings.
- At most eight arguments and C value sizes at most 1,536 bytes, subject to SBF
  stack-frame checks. Larger aggregate copies use shared memory syscall wrappers.

Unsupported terms fail compilation. There is no
recursive data, higher-order code, floating point, IO, parallel scheduler,
generic runtime types or runtime proof arguments. Full Bend remains available
to write proofs, subject to the unsafe/foreign dependency gate.

## Solana interface

Instruction data is exactly one byte, `0` (release). Accounts, in order:

1. Writable escrow state, owned by this program.
2. Authority account, whose key must match the stored authority and whose signer
   flag must be set by the Solana runtime.

Duplicate accounts, additional accounts and missing accounts are rejected.
Account initialization is supplied by the test harness; there is no onchain
initializer in this POC.

The state encoding is exactly 48 bytes:

| Offset | Encoding |
| --- | --- |
| 0–3 | ASCII `BND2` |
| 4 | Version `1` |
| 5 | Tag: `0` locked, `1` released |
| 6–7 | Reserved, both zero |
| 8–15 | Amount, unsigned 64-bit little endian |
| 16–47 | Authority public key |

Successful calls return nine bytes through `sol_set_return_data`: tag followed
by the eight amount bytes. Authority, account metadata and lamports are unchanged.
Custom errors: `1` account count, `2` instruction, `3` owner/executable state,
`4` encoding, `5` writable permission, `6` alias, `7` authorization.

The adapter relies on the runtime to supply a valid aligned loader buffer; it
validates the account contents and instruction data within that buffer. It is
specific to that loader ABI and the two-account interface.

## Outputs and assurance boundary

`build/` contains `escrow.h`, `escrow.so`, ELF inspection/disassembly,
`manifest.json` with source and binary hashes, reference vectors, negative-check
results and measured transaction costs. Generated files, dependencies and
compiler outputs are ignored by Git. `Cargo.lock` and `package-lock.json` pin
host/test dependencies.

The checked laws describe the pure Bend transition. The checker, this new
backend, LLVM, account adapter and loader remain trusted components. In
particular, the proofs assume the `authorized` input is correct; signature and
key validation in C are tested but not formally proved. End-to-end differential
tests provide evidence about lowering and encoding, not a proof of their
correctness. Bend's own formal model also documents a gap with its implemented
checker; see the [initial feasibility review](feasibility.md).

The shared SDK now expresses checked u64 arithmetic and full-precision
multiply/divide in ordinary Bend. Separate solver commands establish checked
u64 add/subtract/comparison/division/multiplication and exact 128-bit products
relative to modeled primitives. `npm run verify:wide` adds wide division and
floor/ceiling multiply-divide refinement. Shared custody and token CPIs support all three application lifecycles;
broader SDK capabilities and the full acceptance audit remain
ahead in the implementation plan. The shared storage fixture and vault exercise
System Program creation and initialization; the original escrow example above
retains its initial adapter.

A bounded [arbitrary-program CPI effect family](cpi.md) now supports explicit
program/account keys, permissions, payloads and custody signing. SBF
coverage includes two-call rollback, all supported multi-state counts and external
account grow/shrink propagation. Final integrated acceptance remains pending.
