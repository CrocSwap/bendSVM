# Bounded integer RMSNorm benchmark

Run from the repository root with the pinned Bend, Anza, Bun, Rust and LiteSVM
prerequisites:

```sh
npm run benchmark:rmsnorm
npm run benchmark:rmsnorm:prefixes
npm run benchmark:rmsnorm:indexed
npm run benchmark:rmsnorm:indexed:prefixes
npm run benchmark:rmsnorm:phases
npm run benchmark:rmsnorm:native-arithmetic
```

The command checks and compiles [Bend source](../benchmarks/rmsnorm.bend) and
an [independent Rust SBF implementation](../benchmarks/rmsnorm-rust/main.rs),
requires byte-identical rebuilds, then executes both twice in LiteSVM with a
1,400,000 CU limit. Each run checks canonical return bytes against a separate
BigInt oracle. The report at `build/rmsnorm-benchmark.json` records source and
ELF hashes, toolchain versions, CU and repeatability. The 18 fixtures include
positive and negative rows, seven single-cell locations across pair boundaries,
zero rows, profile limits and expected semantic rejections.

This is a **bounded scalar-gain specialization** of basanos's integer RMSNorm,
not a port of its account lifecycle or full per-element gain vector. It accepts
up to 64 signed two's-complement i64 cells with `|x| < 2^26` and a shared
nonnegative gain at most 65,535. The 64-cell row uses 640 canonical wire bytes;
every measurement carries the same 649-byte instruction, including unused
cells. The kernel computes the exact sum of squares, mean, integer square root,
`rdiv(x << 22, root)`, and rounded gain multiplication from the
[basanos reference](../../basanos/chain/program/src/lib.rs). It returns a signed
wrapping checksum of output cells. Basanos's per-element outputs and full model
geometry are outside this comparison. Bend uses the generic SDK square root with 32 trials below `2^64` and
64 trials for larger inputs, plus checked SDK arithmetic, with guarded native u64 lowering for
`Math.divmod` and `Math.mul32`; Rust uses native signed arithmetic and Newton
integer square root. Both produce the same return checksums on these fixtures.

## Static fold traversal

The default source now uses the existing generic SDK zip fold to visit the row
in order for both sum-of-squares and normalization. It visits all 64 leaves,
applying arithmetic only to the active prefix. A bounded fuel conversion supplies
the prefix length. Arithmetic results, error conditions and the canonical ABI are
unchanged. No compiler intrinsic or handwritten application C was added.

The preserved [indexed source](../benchmarks/rmsnorm-indexed.bend) is reproducible
with `npm run benchmark:rmsnorm:indexed`; its report is
`build/rmsnorm-indexed-benchmark.json`. The historical measurements below refer
to that implementation. Default diagnostic commands now instrument the fold
implementation; consult their fresh reports for current stage costs.

The integrated commands reproduce these matched measurements:

| Active cells | Indexed Bend CU | Fold Bend CU | Rust CU | Fold / Rust |
| ---: | ---: | ---: | ---: | ---: |
| 8 | 12,585 | 10,811 | 6,662 | 1.62× |
| 16 | 18,664 | 12,037 | 8,600 | 1.40× |
| 32 | 30,807 | 14,454 | 12,685 | 1.14× |
| 64 | 55,249 | 19,397 | 21,093 | 0.92× |

The 64-cell mixed row uses 64.9% less CU than indexed Bend with the same SDK,
and 8.0% less than the matched Rust implementation. Smaller rows retain a gap;
this is a bounded workload comparison, not a general compiler or worst-case
bound claim. The generic square-root width selection reduces the folded mixed
rows by 4,392 CU versus the previous 64-trial implementation. Its source checker
proves 70 obligations and detects seven semantic mutations; this source proof
does not verify the compiled SBF binary.

All six commands above passed after integration. They require byte-identical
rebuilds and repeatable CU. The current folded maximum SBF frame is 2,816 bytes,
up from 2,240 bytes before width selection and below the 4,096-byte limit.
The prefix commands check 195 named cases covering every fuel from 0 through
64, ignored out-of-range tails and a failing last active cell. They write
`build/rmsnorm-prefix-benchmark.json` and
`build/rmsnorm-indexed-prefix-benchmark.json`; their matrices are distinct from
the standard 18-case performance comparison. Exact returned case-name
inventories are required before a report is published.

Current folded diagnostic intervals for the 64-cell mixed row are:

| Stage | Fold Bend CU | Rust CU |
| --- | ---: | ---: |
| Decode and validation | 1,772 | 4,012 |
| Sum of squares | 4,049 | 554 |
| Mean | 146 | 101 |
| Integer square root | 4,559 | 918 |
| Normalize and checksum | 9,097 | 15,749 |
| Encode | 118 | 113 |

Marker syscalls add overhead; these intervals are diagnostic measurements,
not instruction costs or worst-case bounds. Integer square root is the largest
remaining measured gap. The sum and normalization improvements come from
source-level traversal using the existing generic SDK fold.

## Historical indexed measurements before width selection

These historical results used the earlier 64-trial SDK square root. The current
indexed command uses the same width-selecting SDK as the folded source; its
updated totals are in the table above.

LiteSVM 0.7.1, SBF v0, pinned Anza LLVM 20.1.7, target generic, optimization
level 2. These are complete instruction totals, including canonical decoding,
kernel and return data. The `mixed` rows use fixed signed inputs and gain 17,777.

| Active cells | Bend CU | Rust CU | Bend / Rust |
| ---: | ---: | ---: | ---: |
| 8 | 16,996 | 6,662 | 2.55× |
| 16 | 23,075 | 8,600 | 2.68× |
| 32 | 35,218 | 12,685 | 2.78× |
| 64 | 59,660 | 21,093 | 2.83× |

A four-point linear fit across only these fixed rows gives about **762 Bend
CU/element** and **258 Rust CU/element**. The fit is a workload diagnostic,
not a worst-case bound. At 64 all-zero cells, Bend uses 59,685 CU and Rust 8,509.
The fixed 12-bit requantization uses an exact shift in both implementations.

The diagnostic command instruments separate copies of the two compiled programs
with seven CU markers and runs five successful fixtures twice. Its report is
`build/rmsnorm-phases/report.json`; it checks return bytes and exact repeatability,
and confirms the production artifact hashes did not change. At 64 mixed cells,
the intervals from `baseline → decoded → sum → mean → sqrt → normalized →
encoded` are:

| Stage | Bend CU | Rust CU |
| --- | ---: | ---: |
| Decode and validation | 1,770 | 4,012 |
| Sum of squares | 29,536 | 554 |
| Mean | 134 | 101 |
| Integer square root | 8,969 | 918 |
| Normalize and checksum | 19,478 | 15,749 |
| Encode | 118 | 113 |

The marker syscalls add overhead, so these are intervals in the diagnostic
ELFs, not a decomposition of the production total. The preceding limb-based
build used 173,921 CU on the 64-cell mixed row. Guarded native arithmetic now
brings it to 59,660 CU (65.7% less); the original build before the SDK division
guard used 266,335 CU. The remaining diagnostic gaps are largest in sum of
squares and integer square root. These interval costs include other work at
their boundaries and do not isolate one operation.

The benchmark establishes equality of the recorded return checksums and
rejection codes for these inputs, not equality of every intermediate or
per-element output. The source-level division proof does not verify the C/SBF
lowering or this complete kernel. These measurements do not establish worst-case
CU. Row access and the rounded quotient still share the normalization interval;
isolating them would guide the next optimization.

## Historical indexed native arithmetic comparison

The third command regenerates the limb-based headers from the same checked
Bend source, then replaces only the `Math.divmod` and/or `Math.mul32` function
bodies with guarded unsigned C `u64` arithmetic in diagnostic SBF ELFs.
It checks SBFv0 imports and stack limits, confirms native `div64`/`mul64`
instructions, and runs all 18 oracle fixtures twice per ELF with identical
return bytes and CU readings. It checks that the both-native diagnostic matches
the production CU readings and that production artifacts and their recorded
source hashes did not change. The reproducible report is
`build/rmsnorm-native-arithmetic/report.json`.

| Mixed active cells | Limb baseline | Native divmod | Native mul32 | Both native / production | Rust |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 8 | 38,068 | 23,664 | 31,404 | 16,996 | 6,662 |
| 16 | 58,726 | 30,095 | 51,714 | 23,075 | 8,600 |
| 32 | 96,953 | 42,944 | 89,243 | 35,218 | 12,685 |
| 64 | 173,921 | 68,783 | 164,830 | 59,660 | 21,093 |

At 64 cells, native division alone removes 105,138 CU; native multiplication
alone removes 9,091 CU. Together they reduce the Bend total to 59,660 CU,
or 2.83× Rust. The independent effects nearly add on this fixture.

Production lowering requires the exact checked SDK module source digest and
function signatures. A source edit falls back to ordinary Bend lowering until
the source proofs and digest are reviewed again. `npm run verify:division` and
`verify:multiplication` establish the checked source arithmetic; `npm run
verify:native-arithmetic` checks the exact emitted C bodies and bitvector
pack/split correspondence. SBF and sanitizer differential tests cover recorded
inputs. These checks still trust C/LLVM/SBF lowering and do not prove the final
binary correct for all inputs; see [refinement scope](refinement.md).
