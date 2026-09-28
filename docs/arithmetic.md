# Arithmetic semantics and evidence

The compiler recognizes a small table of functions from the pinned Bend Base
library. It checks their source provenance and signatures, then emits unsigned C
operations. Application and SDK functions use the normal compiler path.

## Base primitives

`compiler/primitives.ts` specifies add, subtract, multiply, increment, bitwise
operations, one-bit shifts, comparisons, min/max, division/remainder and Boolean
operations. `U32` arithmetic wraps modulo 2^32. Right shift is logical. Base
division by zero returns zero; Base remainder by zero returns the dividend.
Those behaviors come from the pinned definitions, not C undefined behavior.
Generated wrappers evaluate each argument once and guard zero divisors.

Variable-width shifts and conversion between runtime `Nat` and `U32` remain
unsupported. Exporting an unsupported Base function produces a compilation error.

## Shared checked-u64 API

`sdk/math.bend` defines `U64{lo, hi}` representing `lo + 2^32 * hi`. All of its
implementations are Bend code, rather than compiler intrinsics.

| Function | Meaning |
| --- | --- |
| `equal`, `less` | Unsigned 64-bit comparison |
| `add`, `sub` | Checked addition/subtraction |
| `mul` | Checked multiplication, using 16-bit partial products |
| `divmod` | Checked quotient and remainder with direct exits, a guarded 32-step route and a 64-step fallback |
| `div`, `mod` | Checked quotient or remainder |
| `add_wrap`, `sub_wrap` | Explicit modular helpers; not safe financial defaults |

Checked arithmetic returns `Ok{value}` or `Err{code}`: 1 overflow, 2 underflow,
3 zero divisor. `divmod` returns `DivOk{Division{quotient, remainder}}` or
`DivErr{code}`. `mul` rejects an overflowing product. Use the separate wide
multiply/divide API below when the product exceeds u64 but the quotient fits.

Division returns directly for a smaller dividend or divisor one. A divisor with
a nonzero high limb starts after the first 32 restoring steps, which cannot
subtract that divisor; the remaining 32 steps process the low dividend limb.
Other nonzero cases retain the 64-step route. The step's top carry bit
participates in the remainder comparison, so the routes support divisors
throughout the full u64 range. They require no runtime recursion or allocation.

## Assurance boundary

`sdk/LAWS.bend` and `sdk/PROOF.bend` establish six guard/zero-divisor properties.
They do **not** prove universal correspondence of the limb implementations
with unbounded integer arithmetic. A separate [SMT refinement check](refinement.md)
now establishes checked add/subtract/comparison for all u64 inputs relative to
the primitive model. A compositional SMT check now also connects the restoring
step, 64-step induction and checked public div/mod wrappers to unsigned Euclidean
division and zero-divisor errors. `npm run verify:multiplication` now adds
compositional checked multiplication and exact 128-bit product refinement.
`npm run verify:wide` adds wide division, composed multiply/divide, floor and
ceiling, with error propagation and rounding overflow. These remain compositional
SMT claims under the documented trust boundary, not Bend proof terms.

`tests/arithmetic.ts` compares primitive operations against Bend reference
evaluation. It compares the u64 library against both Bend reference evaluation
and an independent JavaScript BigInt model. Identical vectors then run through
generated native C with undefined-behavior sanitization and through actual SBF
transactions in LiteSVM. Results are written to `build/arithmetic-vectors.json`
and `build/arithmetic-metrics.json`; these tests are evidence, not a formal
compiler-correctness proof.

The original arithmetic wire dispatcher is a test harness. Account storage,
custody and CPI use the separate shared interfaces described in `interfaces.md`.

On 2026-09-20, `npm test` passed 2,928 arithmetic cases through reference, native
and SBF execution; 924 also checked the SDK result against BigInt. The largest
arithmetic probe transaction used 3,625 CU in pinned LiteSVM. This includes its
test wire adapter and return-data syscall, not a complete financial application.
The six SDK laws passed and all three guard/zero-divisor implementation mutations
were rejected. Undefined-behavior sanitization reported no failures.

## Matched SBF compute probe

Run `npm run benchmark:arithmetic-probe` to build checked Bend arithmetic and an
independent Rust baseline with pinned Anza tools. The command executes the same
fourteen 17-byte instructions in LiteSVM, checks identical 12-byte return data and
outer outcomes, repeats CU measurements, and records source, toolchain and ELF
hashes in `build/arithmetic-probe-benchmark.json`. Both programs use SBF v0,
generic CPU and optimization level 2. The Rust baseline is in
`benchmarks/arithmetic-probe-rust/`.

In the initial 2026-09-28 matched fixture set, checked addition and comparison
were about 1.4× the Rust CU cost and checked multiplication about 1.8×.
The public u64 division optimization then changed selected Bend costs while
all 14 fixture results and Rust costs stayed the same:

| Division fixture | Before Bend CU | After Bend CU | Rust CU |
| --- | ---: | ---: | ---: |
| High-limb divisor | 3,138 | 1,744 | 128 |
| Divisor one | 3,339 | 210 | 128 |
| Dividend below divisor | 3,069 | 205 | 128 |
| Small operands, 64-step fallback | 3,116 | 3,160 | 128 |
| Zero divisor | 168 | 193 | 124 |

The before report is preserved at `build/arithmetic-probe-baseline-20260928.json`;
the after report is `build/arithmetic-probe-benchmark.json`. Modulo uses the same
costs as division for corresponding fixtures. Zero-division returns an error
code from both programs without failing the outer instruction. The large division gap is
consistent with the remaining restoring steps and warrants further arithmetic
investigation; the probe does not isolate individual machine
instructions or establish how much division contributes to an application call.
These costs include the small instruction harness, return-data syscall and
LiteSVM transaction overhead, but exclude application account validation,
storage, token effects and CPI. They are fixture measurements, not worst-case
limits or a general Bend/Rust performance ratio.

The AMM still calls the separate wide division route, which starts with a
possibly nonzero high remainder. Its rebuilt 63,480-byte ELF has the same
SHA-256 (`aef0205fd10d39e8186444a8e8c321ce969df0c7d1786594bbcb08931e64e9ec`)
as the saved pre-change AMM benchmark artifact. The public u64 fast paths
therefore did not change that compiled AMM program; its CU benchmark was not
rerun for this edit.

## Full-precision multiply/divide

`sdk/wide.bend` computes a complete 128-bit product from four 32×32 partial
products. Its internal `U128 { low, high }` uses two `Math.U64` values; its
internal `add` wraps modulo 2^128. The product of two u64 inputs fits exactly.

`Wide.mul_div(a,b,d)` returns the quotient and remainder of the full product,
with a checked u64 quotient. `Wide.floor` returns the quotient; `Wide.ceil`
adds one when the remainder is nonzero, checking the additional overflow.
Zero divisors return error 3; a quotient outside u64 returns error 1. Thus an
intermediate product above u64 is supported, but an unrepresentable final result
is rejected. For example, `floor(MAX,MAX,MAX)` succeeds with MAX, while
`floor(MAX,MAX,1)` fails.

Division first rejects a zero denominator. If the product's high limb is at
least the denominator, the quotient cannot fit in u64. Otherwise the existing
64-step restoring division starts with that high limb as the remainder and
consumes the low limb's bits. This is ordinary first-order Bend code using the
same backend, without new arithmetic intrinsics, recursion or a heap.

`tests/wide.ts` defines 410 cases against independent BigInt arithmetic. Cases
cover full-width products, zero divisors, quotient overflow, both rounding
directions and the boundary where floor fits at MAX but ceil overflows. The
shared `tests/pure.ts` harness checks Bend evaluation and generated native C with
ASan/UBSan, emits canonical interface vectors, and builds the same dispatcher for
SBF. `wide_and_entitlement_oracles_execute_in_sbf` executes those vectors as
signed transactions. Measurements are in `build/wide-metrics.json`.

The separate `verify:wide` command supplies compositional universal integer
refinement for this API under the [documented SMT trust boundary](refinement.md).
Differential tests remain separate evidence for native and SBF compilation.
