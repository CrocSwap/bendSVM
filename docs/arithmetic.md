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

`sdk/math.bend` defines `U64{lo, hi}` representing `lo + 2^32 * hi`. Its
implementations and specifications are Bend code. The compiler emits native
unsigned u64 operations for the exact checked SDK `divmod` and `mul32` source;
changed source or signatures use ordinary Bend lowering.

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

Division returns directly for a smaller dividend or divisor one. When the upper
32-bit dividend limb is below the full divisor, the first 32 restoring steps
cannot subtract; the implementation seeds the remainder with that limb and
processes only the lower 32 bits. This includes all nonzero high-limb divisors
and some one-limb divisors. Other cases retain the 64-step route. The step's
top carry bit
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
SMT claims under the documented trust boundary, not Bend proof terms. The
`verify:native-arithmetic` bridge checks the exact emitted C bodies against
bitvector pack/split, quotient/remainder and product obligations after the
checked source proofs pass. The emitted SBF remains covered by tests rather
than a formal target-code proof.

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

After extending the division guard, a focused run passed 2,956 arithmetic
reference/native cases, including 952 u64/BigInt cases, and the same 2,956
cases in LiteSVM (maximum 15,345 CU on those vectors). Four new vectors cover
both sides of the upper-limb guard for one-limb divisors. The division SMT
check also passed, including an
equality-boundary source mutation with a replayed counterexample. With native
arithmetic lowering, the same 2,956 cases passed in LiteSVM, with a maximum
of 311 CU on these vectors; the generated native C cases passed as well.

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
The initial public u64 division optimization changed selected Bend costs. The
high-limb guard reduced the small-operand route again. The production native
lowering now reduces every nonzero division fixture to 173 CU; all 14 fixtures
still match the independent Rust results:

| Division fixture | Original Bend CU | Limb Bend CU | Native Bend CU | Rust CU |
| --- | ---: | ---: | ---: | ---: |
| High-limb divisor | 3,138 | 1,743 | 173 | 128 |
| Divisor one | 3,339 | 210 | 173 | 128 |
| Dividend below divisor | 3,069 | 205 | 173 | 128 |
| Small operands | 3,116 | 1,716 | 173 | 128 |
| Zero divisor | 168 | 193 | 167 | 124 |

The original report is preserved at `build/arithmetic-probe-baseline-20260928.json`;
the current report is `build/arithmetic-probe-benchmark.json`. Modulo uses the same
costs as division for corresponding fixtures. Zero-division returns an error
code from both programs without failing the outer instruction. In the current
probe, the checked u64 division gap is 45 CU (173 versus 128) on nonzero
fixtures. Checked multiplication uses 216 versus 180 CU for a wide intermediate
and 213 versus 177 CU for overflow. The probe does not isolate individual
machine instructions or establish how much arithmetic contributes to an
application call.
These costs include the small instruction harness, return-data syscall and
LiteSVM transaction overhead, but exclude application account validation,
storage, token effects and CPI. They are fixture measurements, not worst-case
limits or a general Bend/Rust performance ratio.

The public u64 fast paths did not affect the AMM's separate wide division.
A subsequent wide-division optimization is measured in the
[AMM benchmark](amm-benchmark.md). Its full 64-step route remains available
for fitting nonzero-high dividends with divisors larger than 32 bits.

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

Division first rejects a zero denominator. If the product's high word is at
least the denominator, the quotient cannot fit in u64. On fitting inputs, a
divisor of one returns the low word directly. When the high word is zero, the
SDK calls the existing checked `Math.divmod`; canonical application imports
permit its guarded native u64 lowering. For fitting nonzero-high inputs with a
32-bit divisor, two checked u64 divisions process the remaining 32-bit limbs.
Each intermediate remainder is below the divisor, so each dividend fits u64
and each quotient limb fits u32. Larger divisors retain the 64-step restoring
route with the high word as the initial remainder. This is
ordinary first-order Bend code using existing arithmetic lowering, without a
new intrinsic, recursion or a heap. Direct SDK-root exports with noncanonical
aliases may retain the ordinary Bend implementation; the native route is checked
on the actual application roots.

`tests/wide.ts` defines boundary and seeded cases against independent BigInt arithmetic. Cases
cover full-width products, zero divisors, quotient overflow, both rounding
directions, divisors around the 32-bit route boundary, and the boundary where
floor fits at MAX but ceil overflows. The
shared `tests/pure.ts` harness checks Bend evaluation and generated native C with
ASan/UBSan, emits canonical interface vectors, and builds the same dispatcher for
SBF. `wide_and_entitlement_oracles_execute_in_sbf` executes those vectors as
signed transactions. Measurements are in `build/wide-metrics.json`.

The separate `verify:wide` command supplies compositional universal integer
refinement for this API under the [documented SMT trust boundary](refinement.md).
Differential tests remain separate evidence for native and SBF compilation.

## Small-divisor measurement snapshot

The integrated wide-division route uses two 64-bit divisions when the product's
high word is nonzero and the positive divisor fits in 32 bits. Larger divisors
retain the bounded restoring-division route. This is a generic SDK change.

A fresh local FUTA fee/split harness run against the maintained SDK measured:

| Input and operation | Rust | Rust + Bend |
| --- | ---: | ---: |
| `u64::MAX`, fee | 382 CU | 555 CU |
| `u64::MAX`, 80/10/10 split | 593 CU | 782 CU |
| 1, fee | 353 CU | 554 CU |

The previously reported Bend costs at maximum input were 3,682 and 7,086 CU.
The added route check has a small cost for low inputs: fee(1) was 547 CU before
this change. These are matched fixture measurements, not worst-case CU bounds.

The refreshed run passed 45,941 native Rust/Bend comparisons and 286 LiteSVM
cases per image. Its input hashes, library artifacts and results are recorded
in `build/futa-maintained-3bb0b8ad-5651-4a0e-b089-8451b40eac27/audit.json`.
This is parity and CU evidence, not the entire FUTA pilot acceptance suite.
The maintained source-refinement gate separately passed 12 API claims,
15 small-division claims, 15 concrete source faults and four process controls;
see `build/wide-small-divisor-scout/integration/maintained-audit.json`.
Neither result proves general C-to-SBF preservation.

## Explicit signed widths

`sdk/signed.bend` supplies ordinary Bend definitions for two's-complement values
stored in `math.U64`:

- `extend32(bits)` sign-extends all 32 input bits into the 64-bit representation.
- `byte_bits(value)` interprets the low eight bits as signed and returns their
  32-bit two's-complement representation. Higher input bits are discarded.
- `mul8(left, right)` returns the exact signed product of those low-byte values.
- `add32_wrap(left, right)` adds the low words modulo 2^32 and sign-extends the
  result. Input high words are discarded. It is not general 64-bit addition.

These operations are defined for every input bit pattern. Callers that require
canonical byte inputs must separately reject values above 255. Using
`add32_wrap` in place of signed 64-bit addition requires bounds on both inputs
and the sum. The linear benchmark experiment establishes a 32-term signed-byte
sum in [-520192, 524288]; that bound does not apply to arbitrary callers.

`npm run verify:signed-lowering` checks five source-semantic obligations and the
complete 12-function emitted-C closure. Its fresh receipt binds source files,
input, frontend checks and the exact proof report. `npm run test:signed-lowering`
adds 23 report-corruption refusals, four controller failures, four source
mutations, four symbolic C mutations, and 271,624 native comparisons with four
native C fault replays under ASan/UBSan. The native oracle covers every low-byte
pair with several high-bit patterns, plus extension and wrap boundaries.

The gate is included in `verify:all`. Benchmark-source integration and the
caller's bounds qualification remain separate work. This module introduces no
compiler intrinsic and establishes no C-to-SBF preservation theorem.
