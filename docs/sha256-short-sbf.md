# SHA-256 short marshalling in actual SBF

This focused gate executes the accepted short-message marshalling generator in
LiteSVM using its standalone observation harness. It does not exercise the
public build command. Source-qualified program builds are described in
[qualified SHA builds](sha256-qualified-build.md).

## Run

Use Bun 1.4.2, the pinned clean Bend checkout at
`7561656155a4285c1e4ccfcb3505ab59524de973`, Anza platform-tools v1.53
(Clang/LLD 20.1.7), and the already-built LiteSVM 0.7.1
`scripts/test-runner/target/debug/bend-test-runner`:

```sh
bun tests/sha256-short-sbf.ts
```

Set `SBF_TOOLS` if platform-tools are outside the default cache path. Set
`SHA256_SHORT_SBF_RUNNER` if the read-only runner is outside this checkout. The
runner must hash to the pinned SHA-256
`3cd6f111c4db06be2f129c8b4fd93543e38b6d5e59d855d6e501745be6bdfe7a`
(re-recorded 2026-10-09 after a rebuild from unchanged runner sources; previously
`77df0dc19a4b496408bb185c3951b22e25efc90619a411ce6674a988c1298e83`); the
environment variable changes only its path, never that requirement. The gate
does not build Cargo or modify shared dependencies. It makes a fresh directory
under this worktree's `build/sha256-short-sbf/runs/` for C, headers, schemas,
stack reports, ELFs, the runner transcript, and either `evidence.json` or a
`failure.json` marker.

## What the gate executes

Each run checks the adjacent law/proof source, emits `hash_short` and its actual
runtime schema with `nativeArithmetic: false`, and explicitly calls
`generateSha256Short(emitted.schema, identity)`. It writes and links the fresh
generated C. The generator is not applied to a checked-in or previously
generated implementation. The input constructors and all 64 slot paths come
from the emitted schema and its pair layout.

The gate builds a separate checked-source reference ELF from the same fresh
checked Bend C, without the SHA replacement. It executes that reference ELF and
the specialized real-syscall ELF in LiteSVM for 77 cases. The reference ELF is
the checked Bend source compiled through the current backend; this gate does
not interpret the Bend term separately for every case.

Cases include every length from 0 through 55, with high-valued inactive slot
poison; fixed SHA fixtures; byte values 0 and 255; forward/reverse order cases;
lengths 56, 64, and U32 max; active byte 256 and U32 max at both the first and
last positions; and additional inactive-slot poison variants. For accepted
messages, results must match both Node's independent SHA-256 and the checked
source reference ELF, including the canonical digest word order. Rejected
messages must return exactly the checked `Rejected` wire value, with no digest.
Before each successful dispatch, the test adapter poisons the scratch output
region and writes an FNV-1a marker derived from that transaction's instruction
bytes. The test checks the marker and complete output after every successful
reference and actual-SBF transaction. This makes a prior `Rejected` value
unable to satisfy the next rejection case. Separately, malformed constructor
tag, truncated canonical input and trailing-byte inputs must each fail with
exact `InstructionError(0, Custom(205))` and the adapter's custom-error log in
both ELFs. These are wire-adapter refusals. They are distinct from a valid
canonical message whose checked program returns the semantic `Rejected` value.

Two additional SBF mutations exercise detection. A byte-zero mutation compiles
and loads but changes the message before the real SHA syscall; its successful
digest must disagree with the host and checked-source outputs. A failure-path
mutation replaces the generated trap with `Rejected`; with the injected
nonzero status it returns a successful, exact `Rejected` result, demonstrating
that the test detects removal of the trap.

## Test-only import profiles

The final ELF imports are checked exactly after linking. These profiles are
local to this test and do not widen `scripts/build.ts`:

| ELF | Exact undefined imports | SHA implementation |
| --- | --- | --- |
| Checked source reference | `sol_log_64_`, `sol_memcpy_`, `sol_set_return_data` | Checked Bend C; no SHA syscall |
| Real syscall | `abort`, `sol_log_64_`, `sol_memcpy_`, `sol_set_return_data`, `sol_sha256` | LiteSVM's Solana SHA syscall |
| Semantic mutation | `abort`, `sol_log_64_`, `sol_memcpy_`, `sol_set_return_data`, `sol_sha256` | Real syscall, mutated marshalled byte |
| Injected failure with trap | `abort`, `sol_log_64_`, `sol_memcpy_`, `sol_set_return_data` | Locally linked `sol_sha256` test shim |
| Injected failure without trap | `sol_log_64_`, `sol_memcpy_`, `sol_set_return_data` | Same local shim; trap deliberately removed |

The fault shim writes a sentinel to its temporary result and returns
`0x123456789abcdef0`, except for a designated one-byte control input where it
returns zero. The successful control must store the shim digest and retain the
adapter's pre-dispatch scratch write. The trapping ELF then runs a different
valid input and must fail in LiteSVM with exactly
`InstructionError(0, ProgramFailedToComplete)` and the SBF panic log. The test
compares the failed transaction's scratch account with the successful control's
snapshot. A `sol_log_64_` event in each failed transaction must contain volatile
readbacks of the scratch marker, poisoned length and sample byte before dispatch.
Data is restored; owner, lamports and executable are checked unchanged, since
the test never mutates them. This is rollback evidence for
these test-shell account writes under LiteSVM; it is not a general runtime
theorem about arbitrary program writes. This instrumented ELF is separate from
the real syscall ELF and is not evidence about Solana's SHA syscall result.

The reusable runner does not expose instruction return data. A test-only
entrypoint therefore stores successful wire output and its input-derived marker
in a small program-owned scratch account and also calls `sol_set_return_data`.
It poisons the output area before dispatch, including for valid messages that
semantically return `Rejected`. Failed wire-adapter and syscall transactions
are checked against their pre-transaction account snapshots. These account
operations are part of the transaction-level compute measurements.

Every Clang `.su` row for the entrypoints, runtime memory helper, and fault shim
is checked against 4,096 bytes. The receipt records each ELF's maximum frame
size and frame count, plus hashes of the generated stack reports; it does not
embed every individual stack row. The final ELF header is checked as SBPFv0 and
each final ELF's exact undefined-import set is checked. The gate verifies the
Bun, Clang, LLD, readelf, pinned LiteSVM runner and pinned Bend versions/hashes,
hashes generated artifacts, and checks that source inputs and artifacts did not
change during execution.

## Recorded run and limits

Evidence lives under the current worktree's ignored `build/` directory, so a
path printed by one worker is not a portable repository artifact. A successful
run prints the exact relative `evidence.json` path after all case, mutation,
tool, source and artifact postchecks complete. A run writes `evidence.json`
with `passed: true` only after those checks pass. A failed attempt writes
`failure.json` with `passed: false` when the process can catch the failure; it
does not write a success receipt. Run directories are UUID-named and are not
cleaned up by later runs.

The receipt records the actual executing script path and hash (`import.meta.path`),
prerequisite source hashes, generated schema and definition hashes, five ELF
hashes/import sets, stack summaries, case outputs, tool binaries and the runner
transcript. The prerequisite snapshot is listed in
[`tests/sha256-short-sbf/prerequisite-hashes.json`](../tests/sha256-short-sbf/prerequisite-hashes.json)
and must be included with this test. Historical runs and partial attempts remain
in their original build directories; their receipts apply only to their recorded
inputs.

For a specific run's case count and compute-unit measurements, use its local
`evidence.json`. Those are LiteSVM harness transaction measurements that include
adapter, dispatcher, account storage, scratch freshness writes, observation logging and return-data
work. They are not isolated handler costs, formal bounds, or claims about other
environments.

Finite execution and mutation results do not establish source qualification,
general SHA-256 correctness, compiler correctness, LLVM/linker correctness,
production resource bounds, or deployment behavior. No deployment or full
regression suite is part of this focused gate.
