# Mixed Rust/Bend library fixture, schema version 1

This file freezes the fixture wire contract independently of the compiler
exporter. It is deliberately smaller than any DCG envelope.
The [artifact contract](../../docs/library-artifact-contract.md) specifies
target profiles, selected files, hashes and GoSVM/Rust consumer checks.

## Checked Bend roots

The primary root is `mixed.evaluate(Request) -> Decision`.

```text
Request = Run { enabled: Bool, value: U32 } | Stop {}
Decision = Accepted { value: U32 } | Refused { observed: U32 }
```

For `Run { enabled = True, value = x }`, the result is `Accepted { x + 2 }`
when `x < 41`, otherwise `Refused { x }`. A disabled `Run` is refused with its
value, and `Stop {}` is refused with value zero. `evaluate_alt` has the same
wire widths and a distinct root identity; it is used to check that a caller
cannot bind a same-width root accidentally. The host harness also builds a
schema variant with the same root name and byte widths but renamed result
constructors. Its binding remains an unresolved import when linked to the
primary object. The pinned Rust SBF link succeeds and leaves the variant's
root/schema-specific symbol unresolved; LiteSVM then rejects the ELF when it is
loaded. The symbol prevents accidental binding to the primary export, while
the loader supplies the rejection. For `solana-v3` the loader does not: the
SBPFv3 link must use `--no-undefined`, which refuses the variant binding at
link time (`tests/target-profiles.ts`).

## Canonical bytes

The fixture uses runtime schema version 1. ABI input is the canonical encoding
of the root argument, with no selector or C layout:

| Value | Encoding |
| --- | --- |
| `Bool` | One byte (`0 = False`, `1 = True`) |
| `U32` | Four little-endian bytes |
| `Request` | One constructor tag, then the widest variant payload; shorter payloads are zero padded |
| `Decision` | One constructor tag and four little-endian payload bytes |

The input is exactly six bytes and the result is exactly five bytes. `Run` has
tag 0 and contains the Bool byte followed by U32. `Stop` has tag 1 and requires
five zero padding bytes.

| Case | Input bytes | Result bytes |
| --- | --- | --- |
| enabled zero | `00 01 00 00 00 00` | `00 02 00 00 00` |
| accepted boundary 40 | `00 01 28 00 00 00` | `00 2a 00 00 00` |
| refused boundary 41 | `00 01 29 00 00 00` | `01 29 00 00 00` |
| disabled 41 | `00 00 29 00 00 00` | `01 29 00 00 00` |
| stop | `01 00 00 00 00 00` | `01 00 00 00 00` |

Tags outside the defined constructors, Bool bytes outside 0/1 and nonzero ADT
padding are malformed. `tests/mixed-library.ts` checks valid and malformed
encodings against the host object; the Rust-linked image checks them in
LiteSVM.

## ABI v1

The build emits one full-SHA256 fingerprint and a root-specific C symbol of the
form `bend_library_v1_call_<fingerprint>`. The fingerprint covers ABI version,
root name, root signature, runtime schema version and the canonical type
schemas. The generated C header names that symbol. The generated Rust
`library.bindings.rs` supplies the matching `#[link_name]`, signature, byte
sizes and status constants. Linking a caller built for another root or schema
may still succeed at the SBF link step: the linker preserves the different
symbol as an unresolved import. LiteSVM rejects that ELF when loading it. The
root/schema-specific symbol prevents it from resolving to an unrelated
same-width export.

The ABI call has this signature:

```c
uint32_t generated_root_schema_symbol(
    const uint8_t *input,
    uint64_t input_len,
    uint8_t *output,
    uint64_t output_capacity,
    uint64_t *output_len);
```

The call accepts only a fixed-width canonical v1 argument encoding. Status
meanings are:

| Status | Meaning |
| --- | --- |
| 0 | The pure Bend root ran and its business result was encoded, including `Decision.Refused` |
| 1 | Required pointer is null, or null input is paired with a nonzero length |
| 2 | A declared pointer range wraps the address space |
| 3 | Declared input, output-capacity or output-length ranges overlap |
| 4 | Input length or canonical input encoding is malformed |
| 5 | Output capacity is too short |
| 6 | `output_len` is not aligned for `uint64_t` |
| 7 | The root returned a value that the canonical output encoder cannot encode |

Checks run in this order: null use, pointer-range overflow, `output_len`
alignment, aliasing, exact input length and canonical decoding, output capacity,
then root execution and output encoding. This makes malformed input take
precedence over a short output buffer; pointer and alias errors take precedence
over both. Status 4 is exclusively an input error. Status 7 is an internal
output-encoding failure and does not reclassify malformed input.

The wrapper decodes arguments, computes the root result and encodes into private
locals, then copies bytes and publishes the length only after all checks pass.
For any nonzero status, each supplied accessible output and output-length region
remains unchanged; null pointers are never dereferenced.

Callers must provide readable `input[0..input_len)`, writable
`output[0..output_capacity)`, and writable `output_len` storage. `output_len`
must be non-null, aligned for `uint64_t`, and non-overlapping with both byte
ranges. `output` must be non-null because this root has a nonempty result;
`input` may be null only when `input_len` is zero. Pointer ranges must not wrap.
These checks cannot establish that arbitrary non-null addresses are mapped or
accessible; that remains a caller precondition. No input/output pointer is
retained after return.

The v1 symbol and status meanings are stable. A change to call layout,
canonical encoding rules or status meanings requires a new ABI version. The
proof laws cover disabled and stop requests, the decision helper's true/false
branches, and the literal enabled inputs 40 and 41. Host and LiteSVM cases also
exercise accepted/refused requests, malformed values and ABI boundary behavior;
these finite cases do not establish the result for every U32 input.

The acceptance receipt captures the checked Bend inputs before each library
build, checks them again after checking and at the end of the gate, and compares
the build manifest input and artifact hashes. It records the actual Bend
checker file hash plus the observed clean pinned revision before and after each
build and the full gate. The source hashes and tool records identify the exact
inputs used for this run; they do not prove the compiler or checker correct.

Build and exercise the mixed image from the repository root with:

```sh
npm run build:library -- tests/mixed-library/PROOF.bend mixed.evaluate build/mixed-library/library
npm run test:mixed-library
```

The first command emits `library.sbf.o`, `library.host.o`, a C header and a Rust
binding. The Rust SBF caller links the SBF object with Anza Rust's generic
`sbpf-solana-solana` target; the second command runs the linked image in
LiteSVM. The build also emits `library.sbf.memory.o` for freestanding C SBF
callers. Do not link that support object into a Rust SBF image: pinned Rust
`compiler_builtins` already defines standard memory helpers. Off-chain C callers
link the host object and their normal host runtime.

Library builds start from `PROOF.bend` so the proof gate checks adjacent laws,
but an exported root must originate in an application/runtime Bend module.
Roots defined in `PROOF.bend` or `LAWS.bend` are rejected. The slice exports
checked pure roots supported by the existing backend; it does not accept
account pointers, effects, stateful handlers or arbitrary C intrinsics. The
build fails if a generated frame exceeds the existing 4,096 byte limit.
