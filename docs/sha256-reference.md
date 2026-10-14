# Checked Bend SHA-256 reference

`sdk/sha256-reference.bend` is a portable, ordinary checked Bend definition of
SHA-256 compression and a short-message hash entrypoint. It does not call a
foreign function, use an unsafe value, or rely on backend/runtime SHA
specialization. The backend sees the same source algorithm that the Bend
checker evaluates.

## Input and output contract

`hash_short` accepts `Message{length, bytes}`. `bytes` is a fixed 64-slot tree
of `U32` values. The active byte sequence is exactly `bytes[0..length)`, where
`length` must be 0 through 55 and each active U32 must be at most 255. Lengths
56 through `0xffffffff` and active non-byte values return `Rejected{}`. Storage
at every index greater than or equal to `length` is inactive and ignored; it
may contain any U32 value. The implementation constructs the `0x80` padding
byte and 64-bit big-endian bit length itself, packs the block as sixteen
big-endian U32 words, expands the 16-word schedule as a ring, and performs the
64 standard SHA-256 rounds with the standard initial state and round constants.

`Hashed{digest}` contains eight U32 words `h0` through `h7`. Each word is the
corresponding four digest bytes interpreted big-endian, in SHA-256 output
order. The canonical Bend wire codec still serializes each U32 in its ordinary
little-endian encoding; callers that need raw digest bytes must write each
word big-endian. The fixed `Message` layout is 520 native bytes and 325 wire
bytes. The emitted closure's largest measured type is 652 native bytes and 409
wire bytes, within the documented 1,536-byte native and 1,024-byte wire-value
limits.

The source uses bounded Nat iteration for byte validation, block-word
construction, schedule rounds, and compression. Rotate helpers use only
unsigned Bend U32 operations. Addition, multiplication, and bitwise operations
use wrapping arithmetic modulo 2³², as in the existing Base U32 lowering.

## Evidence and limits

`tests/sha256-reference/LAWS.bend` and adjacent `PROOF.bend` are loaded by
`checkedBook`; they contain no proof holes or foreign/unsafe bindings. The laws
establish the 55/56 length predicate and 255/256 byte-value predicate boundaries, and rejection
for 56-byte and maximum-U32 lengths. They do not state that SHA-256 is secure or
prove the compression function correct for all inputs. Rejection of a non-byte
active slot by `hash_short` is tested, rather than established by a universal law.

`tests/sha256-reference.ts` evaluates the checked Bend source, compares its
eight output words with independent `node:crypto` digests, emits the same source
through the generic backend to native C, and compares the C dispatcher output
byte-for-byte with the checked Bend result. The 13 cases include seven fixed
digest vectors, two inputs that vary only inactive slots, and four rejected
length/active-byte values. The source test also mutates a round constant to
check that a digest-vector disagreement is classified separately from process
spawn/compiler failures. The native C harness passes AddressSanitizer and
UndefinedBehaviorSanitizer.

The same focused gate then compiles a test-only zero-account Solana instruction
adapter around the generic wire dispatcher and executes its fresh ELF in
LiteSVM. It runs all 13 cases generated during that invocation and compares the
exact canonical return bytes and return-data program ID. LiteSVM may set the
program ID even when the program returns no data, so byte equality supplies
the evidence that the expected result was returned. The four invalid Bend
values are successful Solana instructions returning canonical `Rejected{}`
bytes. Three additional adapter probes require explicit transaction errors for
a nonzero account count, an instruction longer than 1,024 bytes, and an empty
malformed wire encoding. The adapter checks for zero accounts, applies the
canonical wire decoder, and keeps its 1,024-byte return buffer in the
entrypoint stack frame. This is finite SBF execution evidence for this
generated artifact and adapter; it is separate from the source laws and the
finite Node/native vector comparisons.

The oversized-instruction probe exercises LiteSVM defensively; its transaction
exceeds the cluster packet limit.

The report records per-case transaction compute units (including the compute-budget instruction), the maximum measured CU, the actual
entrypoint frame, program ID, exact return bytes, before/after source and
artifact hashes, selected Rust/Cargo tool paths and versions, and the executed
Rust test binary hash. Those tool hashes identify the local files that were
invoked; they do not attest tool provenance. The adapter is test-only and is
not a deployed application entrypoint. These checks establish no universal
SHA-256 theorem, security claim, compiler verification, SHA intrinsic, or
multi-block behavior.

Run the focused gate from the repository root with:

```sh
cargo +1.92.0 fetch --locked --manifest-path tests/sha256-reference/Cargo.toml
npm exec -- bun tests/sha256-reference.ts
```

The focused gate requires Bun 1.4.2, the pinned clean Bend checkout, Anza
platform-tools v1.53, host Clang, and real Rust/Cargo 1.92.0 binaries. The fetch command provisions the locked crates on a fresh machine. The gate runs
Cargo with `--locked --offline` and uses the dedicated local cache at
`target/sha256-reference-sbf-gate`. It is intentionally not registered in
`npm test`; the host can add that integration separately.

The canonical report is `build/sha256-reference/report.json`; each invocation
writes fresh artifacts under `build/sha256-reference/runs/`. A previous report
is moved out of the canonical path before work begins and preserved in the
report archive (or in quarantine if archiving fails). Missing tools, source or
artifact drift, SBF compile/load/execution failures, or a nonzero Cargo child
fail the gate without publishing a success report. Every passing receipt
requires fresh source evaluation, native comparison, SBF compilation, and all
LiteSVM cases; a prior receipt cannot satisfy a run. Source, compiler, tool,
Cargo input, and generated artifact hashes are checked or recorded before and
after execution. Native binaries include debug paths, so their hashes identify
a run rather than promise reproducibility across directories.

The source laws cover stated validation boundaries. Node/native comparisons
and LiteSVM executions cover only the finite cases recorded in the receipt.
None establishes universal cryptographic correctness, deployment behavior, or
end-to-end compiler correctness.

This is intentionally not the full bounded 1,024-byte SHA API. It does not
process a second block, consume borrowed account data, or integrate a runtime
syscall. Those remain future work. The value form copies/serializes a fixed
64-slot tree and is a reference interface, not a borrowed-view ABI.

## Requirements for a future specialization

Any later syscall/runtime specialization must be attached to a compiler-owned,
uniquely identified checked source binding with an exact signature and
provenance. The proof gate must check the real safe reference body before
lowering; the backend must not recognize a user function by spelling, accept a
shadow binding, or specialize a changed signature. Foreign and unsafe
dependencies must continue to reject, and the proof function must remain out
of the runtime closure.

For this reference, the checked source identity is the definition
`sdk/sha256-reference.bend::hash_short` (resolved as
`../../sdk/sha256-reference.hash_short` from the fixture) with signature
`Message -> HashResult`: `Message` carries a U32 length and `Bytes64`, whose
tree contains 64 U32 slots; `HashResult` is `Rejected{}` or
`Hashed{Digest256{h0..h7}}`. A future compiler binding would need a stable
compiler-owned identity tied to this checked definition and its loaded source
hash, plus this exact type/constructor layout and semantics. A borrowed byte
view or a 1,024-byte multi-block interface has a different signature and must
be introduced and checked as a separate source contract before it can be
specialized.

The specialization must establish semantic equivalence to this source
definition for the exact length, active-byte, padding, endianness, and digest
contracts. The checker model, identity rule, specialization code, runtime
wrapper, syscall ABI/allowlist, and equivalence argument would each need
explicit review and evidence. Until then, this source definition is the
reference path and the runtime/syscall slice is separate.
