# Generated interfaces and initial storage SDK

The backend emits type metadata from checked Bend types. `compiler/codecs.ts`
and `compiler/dispatch.ts` consume that metadata; they contain no application
names or application business rules. `sdk/wire.ts` implements the client side
of the same format.

## Canonical wire format (version 1)

- U32: four bytes, little endian. Bool: one byte, exactly 0 or 1.
- Records and tagged unions: one-byte constructor tag in declaration order,
  followed by the constructor fields in declaration order. A single-constructor
  record also has a tag. Remaining bytes are zero padding to the largest
  constructor's payload size.
- Nested values use the same rules. Native C alignment/padding is never stored.
- Decoders reject incorrect lengths, invalid tags/booleans and nonzero padding.
- Recursive types are unsupported; at most 256 constructors and 1,024 wire bytes
  per value. The backend additionally limits native C values to 1,024 bytes,
  with the SBF compiler enforcing the 4,096-byte frame limit. Large aggregate
  copies/initializers use the wrappers in `runtime/memory.c`. Builds reject
  unresolved imports outside the supported syscall allowlist.

The pure dispatcher accepts a one-byte export index followed by its arguments.
Its input must have the exact generated length, at most 1,024 bytes. Its reply
is the encoded return value. `runtime/invoke.h` provides a stateless SBF wrapper
which accepts no accounts. This interface is useful for pure calls and testing;
it is distinct from the storage interface below.

## Storage adapter (initial version)

```sh
npx --no-install bun compiler/cli.ts tests/storage.bend process build/storage.h --storage
```

This checks the Bend source and emits `.h`, `.schema.json`, `.wire.h`,
`.dispatch.h`, `.c` and `.interface.json` files under the output stem. The `.c`
file is a complete generated SBF entrypoint; applications do not supply C.
`compileSbf` in `scripts/build.ts` builds it with the pinned toolchain. The full
`npm test` command generates, compiles and executes the storage fixture.

The checked function has the shape:

```text
process(context: Context, state: State, instruction: Instruction) -> Outcome
Outcome = Accepted { state: State } | Rejected { code: U32 }
```

The structural interface requires `Context { actor: Key, signed: Bool, slot:
U64 }`, an eight-limb `Key { a,b,c,d,e,f,g,h: U32 }`, and `U64 { lo,hi: U32 }`.
`sdk/context.bend` supplies these types and public-key equality. The adapter
validates this shape and constructs the context from the runtime. An instruction
cannot supply its own signer status, actor key or clock slot. Slot is a full
unsigned 64-bit value, obtained through `sol_get_clock_sysvar`; wall-clock
timestamps are not exposed yet.

For transitions without effects, accounts are exactly `[writable state, actor]`;
duplicate accounts are rejected.
The state must be owned by the executing program, nonexecutable and exactly the
generated size. Authorization beyond these structural checks is Bend logic:
for example, the fixture compares the actor's full key with the stored owner
and requires the runtime signer flag.

Instruction data is a mode byte followed by the canonical instruction value:

- `0`: initialize an all-zero allocation. The state address must sign. The
  initial Bend state is decoded from all-zero wire bytes; applications should
  define a nullary uninitialized constructor first. The Bend transition decides
  which initialization instructions are valid and whether the actor may use them.
- `1`: transition an initialized account. The existing header and canonical state
  must decode successfully. A state signature is not required by the adapter.

The 20-byte storage header is `BDS1` followed by the first 16 bytes of SHA-256
over the generated reachable state schema. Type/constructor/field names, tags
and field types are included. Changing function bodies alone does not change
the header. Schema changes currently require an explicit migration design;
there is no automatic migration or account resizing.

On acceptance, the adapter encodes the complete next state into a temporary
buffer before writing the header and payload. It returns the encoded state via
Solana return data. On rejection it returns an error without writing storage.
Account creation can be composed with initialization in one transaction using
the System Program; failed initialization rolls back creation. Creating a PDA
state account through CPI is not implemented yet.

`sdk/storage.ts` consumes the generated schema and interface to encode
instructions and decode account data and replies. It does not encode Context.

Runtime errors are 1 account count, 2 instruction, 3 owner/executable state,
4 storage encoding/size, 5 writable permission, 6 duplicate accounts,
7 initialization signature, 8 clock syscall and 9 invalid generated result.
Bend `Rejected { code }` maps to custom error `256 + code`; codes above
`0xfffffeff` map to runtime error 9. In particular application code zero cannot
accidentally signal successful execution.

## Evidence and remaining scope

`tests/codecs.ts` compares Bend evaluation, client bytes and native generated C,
with ASan/UBSan and malformed/short-buffer cases. Its 288 transaction vectors
also execute in SBF. `tests/storage_sbf.rs` exercises actual signed account
creation, initialization, updates, runtime slots above 2^32, all public-key byte
positions, malformed headers/data/instructions, owner/writable/alias checks,
missing signatures, reinitialization and transaction rollback. The storage
fixture's source law rejects unsigned initialization; a mutation that accepts
it fails the checker.

These tests are evidence of compiler/adapter behavior, not a formal refinement
proof between Solana account bytes and Bend states. The loader buffer and Clock
ABI are trusted platform interfaces. The adapter uses the pinned SBPFv0/LiteSVM
configuration described in the README.

The shared token executor below is now exercised by the vault, vesting, exchange and a two-leg
test probe. Multiple state accounts and general CPI remain
required work in the implementation plan.

## Token effects

A root may instead return `Accepted { state: State, effects: Fx.Effects }`,
using `sdk/effects.bend`. The generator validates the structural SDK types and
emits the same shared executor for every application. `sdk/effects.bend` carries
two effect slots; `sdk/effects3.bend` carries three of the same effect type.
Three-slot interfaces include `effectSlots: 3`; older descriptors omit this field
and retain two slots. Generic CPI remains limited to its existing two slots.
Effects are:

- `None {}`: no operation.
- `CheckMint { mint, mint_key }`: validate a passed mint against an expected key.
- `Transfer { source, destination, mint, mint_key, recipient, amount, authority }`:
  execute SPL Token `TransferChecked` after validation.

The account list is `[state, actor, tokenProgram, custody, remaining...]`, with
4–12 distinct accounts total. Effect indices refer to the full list; token
accounts and mints must use indices 4 or greater. The token program must be the
executable original SPL Token program (`Tokenkeg...`). Token-2022 and wrapped
SOL are not supported by this initial interface.

Custody is the canonical PDA derived with seeds `[b"bend", state_pubkey]` under
the executing program. The adapter checks the supplied custody key, obtains the
bump through the runtime syscall, and uses those seeds to sign custody transfers.
It does not create token accounts; clients compose standard System/Token
instructions to create them, as the vault tests demonstrate.

`Authority` is `Actor` or `Custody`. The source token account must belong to that
authority, and actor-authorized transfers require its runtime signer flag.
`Recipient` is `ToActor`, `ToCustody`, or `ToOwner { key }`. The destination token
account must belong to that recipient. Both token accounts must be writable,
owned by the Token Program and use the expected mint. Account lengths, token
initialization, mint initialization and non-native token state are checked;
source/destination/mint aliases are rejected. Delegated source authority is not
supported. Decimals come from the validated mint account, not instruction data.

Every effect is structurally validated before the first CPI. Transfers execute
in order; stored application state is written only after all succeed. Token
Program failures, including insufficient funds and frozen accounts, fail the
transaction. Solana transaction rollback also undoes an earlier successful leg.
The two-leg test verifies that the first CPI actually succeeded and the second
actually failed before asserting that all four tracked accounts are unchanged.
The three-leg fixture also checks failure on the third CPI, initialization
rollback, prevalidation of the last leg, and successful recovery after failure.

### Custody-controlled issuance

`sdk/issuance.bend` provides a three-slot `token-v2` effect interface. It retains
`None`, `Transfer`, and `CheckMint` with the same fields, and adds:

- `Mint { destination, mint, mint_key, recipient, amount, initialize }`: execute
  SPL Token `MintToChecked`, signed by custody. `initialize = True` additionally
  requires zero supply before the batch. It does not create the mint account.
- `Burn { source, mint, mint_key, amount }`: execute SPL Token `BurnChecked`,
  requiring the actor's signature and ownership of the source token account.
- `BoundTransfer { transfer, source, destination, fresh_destination }`: transfer
  using the same seven fields in a `TransferDetails` record, with independent
  `Binding.Any` or `Binding.Exact { key }` constraints on the two token account
  addresses. A fresh destination must be empty, owned by custody, and have
  neither delegate nor close authority. This lets an application bind its
  immutable reserve addresses and validate initial reserve custody.

Both require a writable original SPL mint with the expected address, the custody
PDA as its mint authority, and no freeze authority. The source/destination must
be a writable non-native token account for that mint; mint recipients must match
the declared recipient. Decimals are read from the validated mint. Delegated
burns are not supported. Supply and balance overflow/underflow are enforced by
SPL Token and cause transaction rollback.

These operations are capabilities, not application authorization: Bend must
decide who may issue, how much, and when initialization is allowed. All guards
run against the pre-batch account state, so `initialize` is a zero-supply check,
not a once-only lock. A pool's state transition must enforce once-only creation.
Additional errors are 23 (wrong mint authority or freeze configuration) and 24
(nonzero initial supply), 25 (bound account address mismatch), and 26 (unsafe
fresh custody destination). Source/mint/account validation uses the existing
token errors. Runtime CPI failures may surface the token program's own error.

Additional adapter errors: 10 token program, 11 custody PDA, 12 effect indices,
13 token/mint ownership, 14 token/mint encoding, 15 mint mismatch, 16 source
authority, 17 recipient, 18 returned CPI failure. The runtime may propagate a
CPI failure directly rather than returning control to the adapter.

PDA isolation, byte decoding, account validation and CPI execution remain trusted
adapter behavior supported by transaction tests. Source proofs concern the
constructed effects and modeled state; they do not independently prove the
Token Program, syscall ABI or executor correct.

## Multiple application state accounts (ABI 2)

The public builder accepts an optional fourth argument naming a layout file:

```sh
npm run build:program -- tests/multi-storage.bend process build/multi-storage tests/multi-storage.layout.json
```

The layout is `{"stateAccounts":["left","right"]}`. The root still has
`(context, state, instruction) -> outcome`; `state` must be a single-constructor
record containing exactly the named fields, in declaration order. Two to four
fields are supported. Each field's type is stored in its own program-owned
account, with its own existing BDS1 schema header and canonical payload. Business
rules remain in the checked root. The layout file is hashed in the build manifest.

Without effects, accounts are `[firstState, actor, otherStates...]`, with exact
count. With token effects they are `[firstState, actor, tokenProgram, custody,
otherStates..., remaining...]`, with at most twelve total accounts. Transfer
indices in the Bend effect must account for the additional state slots. Custody
continues to derive from the **first** state account. The interface JSON lists
each field's account index, type, header and allocation size.

Mode 0 initializes **all** state accounts together: every state address must sign
and every allocation must contain only zeros. Mode 1 requires all headers and
payloads to be valid. Mixed initialization/update is not supported. All state
accounts must be writable, distinct, non-executable and owned by the program.
The root receives the assembled record. The adapter validates every account,
computes the outcome, encodes every output, validates/executes any effects, then
writes all state accounts. The return data is the canonical **aggregate record**.
Transaction rollback still depends on Solana runtime semantics.

`sdk/multi-storage.ts` provides `multiStorageCodec(schema, interface)` with
`instruction(value, mode)`, `account(fieldName, bytes)` and `reply(bytes)`.
Existing single-account builds remain ABI 1 with their existing client API.
No layout file is required for those programs.

The two-account fixture executes initialization and updates in LiteSVM and checks
unchanged state on rejected calls, missing initialization signatures, read-only
secondary state, aliases, missing accounts, owner/header/size errors and repeated
initialization. Its public build and generated artifacts reproduce. The fixture
intentionally has no application authorization rule; it tests adapter mechanics.
Three- and four-state fixtures additionally use distinct record types and rotate
loaded values through all fields. Their aggregate replies and stored values are
checked, along with every state slot, every alias pair, every state-account swap,
initialization signatures, missing/extra accounts and application rejection.
They pass 30 and 44 account-rejection cases respectively, plus signature/count/
application checks. All tracked accounts remain unchanged on failures.
Their public builds and client codecs reproduce; fixture rotation measured
3,817 CU (three states) and 5,682 CU (four states). Reports are in
`build/multi-storage-{3,4}-validation.json`. Effectful fixtures now also exercise all three supported state counts as
described below.


The `multi-token-{2,3,4}` fixtures use the same public layout builder with two
actual SPL Token transfer effects. Token-account indices follow the additional
state slots. Tests create all state accounts via System Program instructions,
initialize them in the same transaction, deposit/withdraw real tokens and check
every state counter and aggregate reply. Invalid secondary state is rejected
before CPI; a custody PDA derived from a secondary state is rejected.

A second-leg transfer failure is observed after a successful first transfer.
Both token balances and every state account remain unchanged. The same failure
during initialization rolls back all System Program allocations as well. Valid
operations subsequently succeed. This covers two, three and four state accounts;
reports are in `build/multi-token-{2,3,4}-validation.json`. Fresh public builds
reproduce all fixture artifacts. These are executor probes with caller-controlled
amounts, not independently secure custody applications. Arbitrary-program CPI
is still outside the SDK.
