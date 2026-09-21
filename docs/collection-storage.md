# Account collection ABI 3 (experimental)

Build a program with an explicit storage layout:

```sh
npm run build:program -- tests/collection-store.bend process build/collection-store tests/collection-store.json
```

```json
{"collection":{"select":"select","element":"U32"}}
```

`element` is the exact checked schema type name. The compiler checks both exported
roots and includes their source dependencies in the build manifest.

The selection signature is `(context, state, instruction, metadata) -> Result<Range>`.
The transition signature adds a fifth `window` argument and returns
`Accepted{state, window, length}` or `Rejected{code}`. An optional fourth field
`effects` in Accepted uses the existing shared effect schema. Metadata has U32
`length, capacity`; the range has U32 `start, count`. The window has U32 `start`
and a bounded vector `entries`. Backing storage is a single element or nested
homogeneous pairs, supporting one, two, four or eight elements, subject to the
usual native/wire/stack limits.

Use `sdk/collection.bend` for context, metadata, ranges and window operations.
Context exposes runtime actor/signature/slot and the collection key. Applications
must implement their authorization and bind the collection key in their state.
The adapter additionally binds each collection header to its owning state address.

Without effects, accounts are state, actor, collection. With effects, they are
state, actor, program/tokenProgram, custody, collection, remaining accounts. All
addresses must be distinct. Both managed accounts must be writable, program-owned
and non-executable. Initialization requires both addresses to sign and both
allocations to be entirely zero. State uses the existing 20-byte schema header.
Collection storage is:

| Offset | Content |
| --- | --- |
| 0 | 20-byte collection schema header, starting BDC1 |
| 20 | U32 little-endian logical length |
| 24 | 32-byte state address |
| 56 | Fixed-width canonical elements |

Capacity is `(allocation_bytes - 56) / element_bytes`; nonintegral capacities,
capacities greater than U32 and lengths exceeding capacity are rejected.
Existing accounts are not resized by this interface.

Selection may reserve inactive slots beyond the logical tail, but it cannot
start beyond the current length or exceed capacity/window bounds. Only active
selected records are decoded. The transition must preserve window origin, retain
all loaded records, and may append only at the tail. Its returned logical length
must exactly equal old length plus appended records. Truncation is rejected.
Only active returned records are encoded. Inactive scratch slots have no storage
meaning and must not be read without the checked vector API.

All result/layout checks and encoding precede effects and managed-account writes.
Generic CPI cannot request writable access to either managed account. After
successful effects, the adapter writes selected records, collection metadata and
small state. A transaction failure relies on Solana rollback for any earlier CPI.
The queue application exercises token effects and late-CPI rollback, including a
two-payment page whose second destination is frozen. An independent collection CPI fixture also exercises actor/PDA signing, callee
failure rollback, permission checks and rejection of writable CPI aliases to
either managed account. Initialization tests require both allocation signers,
reject dirty allocations and prevent reinitialization without writes.

Adapter errors retain the existing storage codes; code 23 indicates rejected or
out-of-bounds window selection. Application Rejected codes map to 256 + code
within the admitted range. Unsupported result structures fail at build time.

`sdk/collection-storage.ts` consumes the generated schema and interface. It builds
instructions, decodes state, reports collection allocation size and metadata, and
decodes bounded record windows. Metadata inspection validates the header and
binding, not the canonical contents of unrequested records.

Run `npm run test:collection` and `npm run verify:collection` for current tests.
This ABI is under development; the fixture has no authorization policy and is
not an application template suitable for deployment.
