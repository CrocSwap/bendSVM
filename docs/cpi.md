# Bounded arbitrary-program CPI effects

`sdk/cpi.bend` supplies a separate effect family for calling arbitrary executable
Solana programs. Applications construct ordinary checked Bend values; the shared
adapter performs the external calls. Existing `sdk/effects.bend` token programs
keep their specialized validation and `token-v1` interface.

A root using `Cpi.Effects` emits a `cpi-v1` interface. It has two effect slots,
each `None` or `Invoke`:

| Field | Meaning |
| --- | --- |
| `program` | Index of the target program in the passed account list |
| `program_key` | Expected target public key; must match the indexed executable account |
| `length` | Instruction byte length, from 0 through 64 |
| `data` | Sixteen U32 words, serialized little endian; bytes after length must be zero |
| `count` | Number of account metas, from 0 through 8 |
| `accounts` | Eight fixed meta slots; only the first count are passed |

Each meta carries `index`, expected `key`, `writable` and `signer`. Writable
permission cannot exceed the transaction's permission. A requested signer must
already be a transaction signer, except custody (index 3), which the adapter signs
using `[b"bend", primary_state_address, bump]`. Requesting no signature forwards
no signature for that meta. Duplicate indices within a CPI are rejected, as are
duplicate accounts in the outer adapter. Unused meta slots are ignored.

Single-state accounts are `[state, actor, program, custody, remaining...]`.
Multi-state layouts keep extra state accounts starting at index 4. The target
program may be any executable account at index 2 or later; the `program` slot is
not constrained to SPL Token. There are at most twelve outer accounts. Custody
must match the primary state even if a particular call does not request its
signature. The application must choose expected keys and requested capabilities
according to its own authorization rules.

All effects are validated before execution. Both run before any managed state is
committed. Managed state accounts may be forwarded read-only, exposing their
pre-transition contents; forwarding them writable is rejected so a callee cannot
change state that the adapter subsequently overwrites. CPI failure rejects the
outer instruction and relies on Solana transaction rollback. Return data from a
callee is not fed back into the already evaluated Bend transition; the adapter
returns its normal encoded next state.

Additional errors are 19 for target program/key, 20 for payload/count/padding,
21 for meta key/index/permissions/duplicates, and 22 for writable managed state.
Error 18 is returned if the syscall returns a failure code; the VM can instead
propagate a callee error directly. Existing custody error 11 still applies.

The C-value cap is now 1,536 bytes to accommodate these fixed-capacity effect
records. Wire values remain capped at 1,024 bytes and SBF compilation still
rejects frames exceeding 4,096 bytes. Not every otherwise valid combination of
large application state and CPI effects will fit those bounds.

## Evidence and remaining work

`tests/cpi.bend` is an executor probe, not a secure application: its caller chooses
the effect. It invokes `tests/cpi-callee.c`, an independently compiled SBF program
that checks signer/writable permissions and updates its own account. Tests check
actor signing, PDA signing, program/key/payload/meta/permission rejection, state
write protection, and rollback after a callee writes then fails. The client wire
encoding and reproducible public build are checked too.

The normal pipeline builds both fixtures and runs them:

```sh
npm test
```

The two-call fixtures now cover single-state roots and two-, three- and four-state
layouts. They check a successful first call followed by a failing second call,
with every external/state account unchanged. Invalid second-effect padding and
writable forwarding of the last managed state are rejected before either call;
the tests require the exact adapter error codes.

The independent callee can grow its owned account from four to eight bytes and
write a marker. A second CPI reads the enlarged account and marker successfully.
A subsequent pair shrinks it to four bytes and uses that size in the next call.
Growth followed by a write-then-fail second call rolls back both data and size.
This directly checks the executor's account-info length refresh across calls.
All managed counters advance only for successful pairs.

The fixtures share the same capability across two calls with different payloads,
keeping transaction instruction size bounded. They are intentionally unrestricted
executor probes, not custody applications. Builds reproduce through the public
builder. Results are recorded in `build/cpi-pair-validation.json` and
`build/cpi-multi{,-3,-4}-validation.json`. Native proof claims for the applications do not establish the
behavior of arbitrary external programs or this runtime path.
