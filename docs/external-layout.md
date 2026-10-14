# External account layout readers

This module is an isolated byte reader and C-view generator for fixed-format
external accounts. It is useful for prototyping the record-byte boundary
described in the DCG settlement pilot. It does not authenticate a Solana
account, run application or settlement rules, or pass account bytes into Bend.

Run the focused gate with:

```sh
npm exec -- bun tests/external-layout.ts
```

As a focused command, this runs the ten TypeScript groups, eleven generated C
groups under AddressSanitizer and UndefinedBehaviorSanitizer, both Anza SBF
compile checks, and the actual eight-case LiteSVM test. The Rust test uses the
caller's Cargo environment and `--locked --offline`. `CARGO_HOME`,
`RUSTUP_TOOLCHAIN`, `CARGO`, `RUSTC` and `CARGO_TARGET_DIR` are respected; when
`CARGO_TARGET_DIR` is unset, the gate uses the worktree's private `target/`.
Normal root CI supplies the documented Rust pin. A missing compiler, sanitizer,
offline dependency or runtime test fails the gate.

`npm test` imports `testExternalLayout()` from `scripts/test.ts`. In this route,
the function runs the same TypeScript, sanitized native C and SBF compile checks
but does not start a nested Cargo build. Its report says
`generatedSbf.runtime.executed: false` and `deferred: true`; that report's
`passed: true` covers the compile checks only. The registered
`external_layout_sbf` module in `tests/sbf.rs` lets the later root
`cargo test --test sbf` runs the LiteSVM test once as part of the existing suite.

Both routes write `build/external-layout-report.json`. At gate start, an old
canonical report is retired by same-directory rename to a unique quarantine.
The gate archives those exact bytes under their SHA-256 name and removes the
quarantine only after verifying the archive. If archiving fails, the original
bytes remain in quarantine and the canonical path stays empty. If a later check
fails, there is still no old `passed: true` report at the canonical path. A new
report is published with an atomic same-directory rename only after the checks
finish. Generated C, logs, the SBF ELF and its stack report stay under the
worktree's ignored `build/` directory.

When the focused command runs LiteSVM, the report records the exact Cargo
command and a selected build-variable presence map (all values omitted, with
no hashes of secret values), the measured Cargo/Rust compiler versions, and hashes of
the actual selected binaries. If a rustup launcher is selected, `rustup which`
resolves the toolchain binary before hashing; the launcher hash is not presented
as a compiler hash. Cargo JSON identifies the emitted test executable and its
SHA-256. The exact SBF ELF digest is checked before and after execution, and
source inputs plus generated reader artifacts are checked for drift.

To run just the LiteSVM target after producing the ELF, use the same caller
environment and its selected `cargo`:

```sh
cargo test --locked --offline --test external-layout-sbf -- --nocapture
```

The test loads the ELF and exercises a 1 MiB borrowed span, the 1,024-row DPA1
window, DCR2 full and prefix allocations, malformed allocation/window cases,
and maximum-size account data. The main repository suite runs
`cargo test --test sbf`. `tests/sbf.rs` registers
`#[path = "external-layout-sbf.rs"] mod external_layout_sbf;` so this same test
runs in the root suite.

The permanent receipt probes can be replayed with
`npm exec -- bun tests/external-layout-receipt.ts`. They copy the current
checkout's gate source files into private fixtures, check their hashes before
and after the run, and reuse `build/external-layout-receipt-target` for Cargo
dependencies unless `EXTERNAL_LAYOUT_CARGO_TARGET` or `CARGO_TARGET_DIR` is set. No saved developer snapshot
or Fadeno worktree is required. The probes run a full
focused gate, import the gate with a poison Cargo executable to check that no
nested Cargo runs, seed opaque non-success prior bytes before a deliberate C
compiler failure, and corrupt the content-addressed archive to check that the
quarantine retains the original bytes. Their opaque fixtures are isolated from
the regular gate's report archive.

The environment digest covers only the sanitized presence map. It does not bind
the full environment or effective Cargo configuration. Cargo build output is
retained verbatim and is trusted not to print secrets; avoid publishing local
build logs without review. The selected tool paths identify the observed tools,
but a custom Cargo configuration can select a different Rust compiler.

The Cargo and Rust toolchain are trusted build inputs. Version and binary hashes,
Cargo's emitted executable hash, stable inputs and before/after artifact hashes
are receipts for what this gate observed; they do not prove that a compiler
emitted a binary from a particular source or prove the toolchain correct.

## Descriptor and size rules

Descriptors are plain data objects. Unknown keys, `null`, sparse arrays,
accessors, duplicate names, invalid field ranges, and unchecked references are
rejected. Integer fields name their byte order. `minimum` and `maximum` may
bound scalar fields used as capacities, counts, or record widths.

`fixedSize` is the required readable header size. An optional `logicalSize` is a
flat checked sum: a fixed `base`, plus at most eight scalar products or ceiling
divisions. The implementation uses checked u64 addition and multiplication in
both TypeScript and C, then caps the result at 10 MiB. For example:

```ts
logicalSize: {
  base: 424,
  terms: [
    {kind: 'multiply', field: 'output_count', byField: 'width'},
    {kind: 'ceil_divide', field: 'output_count', by: 8},
  ],
}
```

`allocation: {kind: 'exact'}` requires the accessible input length to equal the
computed logical size. `allocation: {kind: 'prefix', maxLength}` accepts an
accessible allocation from `fixedSize` through the smaller of `maxLength` and
the computed logical size. A computed logical size greater than `maxLength` is
rejected because that layout could never become complete within the declared
allocation bound; equality is accepted. It returns both `byteLength` and
`logicalSize`, so a caller can tell a fully grown account from an allocated
prefix. Prefix access for windows must be opted into on each window. For
compatibility, an older prefix descriptor without `logicalSize` treats its
supplied byte length as the logical size; new dynamic descriptors should
include the formula.

A `records` window names a fixed offset, a count field, a constant or field
record width, and maximum count/width bounds. Required record windows reject if
any logical record is truncated. `allowPrefix: true` is allowed only with a
prefix allocation; it exposes the largest whole-record prefix present and
reports both accessible `count` and header-derived `logicalCount`. A `bytes`
window can use the same flat formula for its offset and length. An opted-in
prefix byte window exposes only the portion physically available. Every window
is checked against the full logical size, the accessible allocation, its
declared maximum, and other windows for overlap.

The TypeScript reader copies fixed `bytes` and `key32` fields (at most 1,536
bytes total), while its windows are borrowed `subarray` views. Generated C
returns pointers into the input for fixed `bytes` and `key32` fields as well as
for windows; scalar fields are copied into the view by value. A C view therefore
does not freeze the bytes whose magic, reserved value, or key were checked.
Keep the backing account data alive and unchanged from the reader call until
all values and windows in the view have been consumed, and do not retain C
pointers past that lifetime. The same no-mutation rule applies to TypeScript
windows while they are being read; copied TypeScript fixed byte fields remain
snapshots. The C reader rejects any overlap between the accessible input range
and output object. It builds a local candidate view and writes `*out` only after
every validation succeeds; refusal leaves the output byte-for-byte unchanged.

The 10 MiB reader cap bounds accessible account data and logical formulas. This
does not increase Bend's 1,536-byte native value bound, 1,024-byte canonical
wire bound, or 4,096-byte SBF stack-frame bound. The generated view contains
only fixed-size scalar, pointer, and length metadata; it never contains an
account-sized stack array.

## DCG-shaped examples

The tests use synthetic headers and independently written TypeScript/C byte
fixtures for two relevant size patterns:

- A DPA1-shaped exact account has a 304-byte header and `capacity` 80-byte
  outcome rows. With capacity two, the logical and accessible size is 464
  bytes. The C reader returns a borrowed repeated-record window over the rows.
- A DCR2-shaped prefix-grown account has a 424-byte header, `output_count`
  cells of `width` bytes, and `ceil(output_count/8)` bitmap bytes. A 437-byte
  logical record with only 430 accessible bytes exposes one whole 4-byte cell
  out of three and no bitmap bytes. The caller sees that the row window is
  incomplete and must not treat it as a complete ledger.

These are generic shapes, not DCG version codecs. The external layout reader
does not establish the DPA1/DCR2 owner, expected PDA, descriptor or parent
binding, account privileges, alias safety, or consistency with DCR1/DCM2/Clock.
It does not decide challenge eligibility, settlement, payout, or closure. The
focused report marks these exclusions separately from the existing C reader
results.

## Possible Rust handler integration (not implemented)

This repository has no Rust external-layout reader, Rust-to-Bend bridge, or
handler-side fact extractor. The Rust LiteSVM test only invokes the generated C
SBF fixture; it does not establish a Rust reader or a Rust-to-Bend integration.
For a future DCG pilot, the contract assigns account identity and
Solana-dependent checks to the Rust handler. A possible integration design is:

1. Freeze version-specific Rust record structs, descriptor tables, and byte
   goldens against the DCG sources. In each handler, Rust first validates the
   account list, owner, PDA/address provenance from an independent parent,
   descriptor binding, privileges, aliases, version/magic/reserved bytes,
   record size, and Clock facts. A successful byte view must never stand in for
   those checks.
2. Add a handler-owned, versioned fact extractor that borrows `AccountInfo`
   data only during the handler call. It uses exact readers for DPA1 and
   prefix-grown readers for DCR2, retaining both logical and accessible
   lengths. If a rule needs a complete window, the handler refuses until every
   required byte is available; it must not silently promote a physical prefix
   to a complete record.
3. Serialize validated scalar facts and only a bounded chunk of read-only rows
   into an ordinary versioned canonical Bend input. For a repeated DPA1 ledger
   or DCR2 scan, choose chunk sizes so each encoded input stays under the
   existing 1,024-byte wire limit and every reachable native value stays under
   1,536 bytes. Repeated pure calls can carry the ordinary typed fold state and
   chunk; no account pointer, opaque borrowed Bend value, or whole-account
   record is added to Bend.
4. Let Bend choose the policy result over those validated facts. Rust validates
   the returned bounded plan against the prevalidated role and static
   write/close allowlists, then performs account writes, closes, or effects.
   Transaction rollback remains Solana runtime behavior.
5. Add handler-level LiteSVM tests for wrong owner/PDA/parent, aliases,
   truncated required bytes, partial-growth boundaries, row ordering,
   unchanged accounts on refusal, and plan execution/rollback. Keep those tests
   distinct from byte-reader goldens and from Bend law/refinement results.

The reader tests establish the standalone TypeScript/native C behavior and, in
the focused route, LiteSVM execution of the generated C reader over synthetic
accounts. The imported `npm test` route supplies only TypeScript/native C/SBF
compile evidence here; its runtime is deferred to the root SBF suite. Neither
route validates account ownership, addresses, privileges, parent binding, or
settlement handler behavior. The versioned Rust handler bridge, settlement Bend
root, account authorization, handler policy, proof integration, and DCG source
changes remain unimplemented. Those need a separate backend-owned design and
patch; the existing Bend proof gate should remain unchanged.
