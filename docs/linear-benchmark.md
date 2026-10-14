# Bounded quantized linear-row benchmark

Run `npm run benchmark:linear` from the repository root with the pinned Bend,
Anza, Bun, Rust and LiteSVM prerequisites. The command builds
[checked Bend](../benchmarks/linear.bend) and an
[independent Rust SBF program](../benchmarks/linear-rust/main.rs), requires
byte-identical rebuilds, and executes each program twice in LiteSVM. The
report at `build/linear-benchmark.json` records source and ELF hashes, target
versions, per-fixture CU and repeatability. All return bytes are checked
against a separate BigInt oracle.

This is one bounded 32-term tile of Basanos's
[`linear_row`](../../basanos/chain/program/src/lib.rs), not its complete
matrix operator or account lifecycle. Two fixed rows carry quantized signed
i8 activations and weights, encoded as U32 values in 0–255. The active prefix
has 1–32 terms. The kernel computes the signed dot product and then Basanos's
two rounded fixed-point stages, with `P1=16` and `P=32`:

```text
t   = (dot * multiplier + 32768) >> 16
out = (t * activation_scale + 32768) >> 16
```

The right shifts are arithmetic, including negative ties. The multiplier is
at most 65,535 and activation scale at most 1,048,576; these bounds keep both
intermediate products within signed i64. Invalid active bytes, empty or longer
prefixes and out-of-profile scales return error 1. Unused row cells are present
in every instruction but are not part of the active dot product. Each fixed
instruction is 333 canonical wire bytes and has no accounts or CPIs.

The 21 fixtures include mixed 4/8/16/32-term rows, six single-cell positions
across pair boundaries, zero values, positive and negative rounding ties,
zero scale, and semantic rejections, including a maximum U32 active count.
The Rust implementation decodes the same canonical shape independently and
uses native signed arithmetic. The Bend version uses the checked SDK arithmetic
and generic compiler; there are no
kernel-specific compiler branches or handwritten application C. It traverses
the Pair rows with the reusable checked-Bend
[`zip-fold`](../sdk/zip-fold.bend), visiting each leaf once in order. As with the
[RMSNorm benchmark](rmsnorm-benchmark.md), fixture agreement and repeatable CU
measurements are evidence for these inputs, not universal compiler correctness
or worst-case compute bounds. Rejection fixtures check output semantics; the
two implementations may detect an invalid value at different points, so the
performance comparison below uses successful rows only.

## Measured results

Results use LiteSVM 0.7.1, SBF v0, generic CPU, and optimization level 2.
The whole transaction instruction is measured, including canonical decoding
and return data. The mixed rows use fixed signed-byte patterns, multiplier
50,000 and activation scale 500,000.

The promoted SDK signed-width source passed the 21-case independent oracle,
repeated builds and repeated CU checks in the isolated measurement harness at
`build/linear-width-scout/promoted/report.json`. That harness reuses the cached
host runner and pinned target tools; this is distinct from a fresh execution of
the public benchmark command. The old wide implementation is preserved in
[`linear-wide.bend`](../benchmarks/linear-wide.bend).

| Active terms | Current Bend CU | Wide reference CU | Rust CU | Current / Rust |
| ---: | ---: | ---: | ---: | ---: |
| 4 | 1,740 | 2,141 | 3,086 | 0.56× |
| 8 | 1,862 | 2,386 | 3,178 | 0.59× |
| 16 | 2,084 | 2,850 | 3,362 | 0.62× |
| 32 | 2,565 | 3,821 | 3,730 | 0.69× |

The current implementation uses generic `Signed.mul8` and `Signed.add32_wrap`.
Validated byte inputs and at most 32 terms bound the accumulated dot product to
[-520192, 524288], allowing signed 32-bit accumulation without overflow.
`verify:linear-width` checks the source-level equivalence to the retained wide
reference, including invalid-input behavior and ordered fold composition.
`test:linear-width` adds report, process and source-model failure controls.
These checks do not prove the complete emitted C or SBF kernel.

The signed-width change reduces the 32-term Bend cost by **32.9%**. Four-point
fits give about **29.4 current Bend**, **59.9 wide Bend**, and **23 Rust CU per
active term**. These are slopes for the fixed measured rows, not instruction
costs or worst-case bounds.

The earlier indexed Bend source is preserved in
[`linear-indexed.bend`](../benchmarks/linear-indexed.bend). Run
`npm run benchmark:linear:indexed` to reproduce its independent-oracle,
byte-identical-build and repeated-CU report at
`build/linear-indexed-benchmark.json`. Its 32-term row was 9,065 CU versus
the same 3,730 Rust CU. The earlier wide-arithmetic checked Bend zip fold reduced that Bend result by
**57.8%**, without a compiler intrinsic or C rewrite. A direct, benchmark-local
static fold also passes the same SBF oracle at 3,866 CU; the generic SDK fold
is slightly faster on this fixture. The zip fold always visits 32 leaves and
checks the active prefix in the accumulator, so its short-row costs and
invalid-input timing should not be interpreted as a general dynamic-loop
speedup.

## Generated-C diagnostic

Run `npm run benchmark:linear:diagnostic` after the indexed benchmark. It
checks the indexed source and artifact hashes, builds isolated copies of
the generated indexed Bend C, and runs all 20 oracle fixtures twice for each
variant. The report is `build/linear-diagnostic/report.json`; indexed ELFs,
vectors and benchmark report are required to remain byte-identical. The diagnostic
also checks SBF stack frames against the 4,096-byte limit. These C mutations
are measurement probes, not checked Bend implementations or production
compiler lowerings.

| Diagnostic Bend variant | 4 terms CU | 32 terms CU |
| --- | ---: | ---: |
| Indexed generated C | 2,218 | 9,065 |
| Cache repeated row lookups | 2,218 | 9,065 |
| Native signed product and accumulation | 2,078 | 7,957 |
| Pointer traversal of nested pairs | 2,104 | 7,929 |
| Native step plus pointer traversal | 2,042 | 7,496 |
| Bounded U32 dot step plus pointer traversal | 2,024 | 7,310 |
| Eager flat U32 buffers, original arithmetic | 1,642 | 3,424 |
| Eager flat buffers plus bounded U32 dot step | 1,533 | 2,524 |

Clang already eliminates the duplicated row getter calls in the indexed loop: manual
caching and a ternary form of `B.pick` do not improve the 32-term result. An
eager, indexed flat view of the two validated nested-pair rows has the largest
effect. It brings the diagnostic 32-term row below Rust's 3,730 CU even before
the U32 dot step. The direct-field diagnostic relies on the generated C layout
and validated canonical tags, and pays to flatten all 32 cells regardless of
the active prefix. The checked Bend zip fold achieves nearly the same 32-term
total as Rust without relying on those C layout assumptions. A future compiler
flattening transformation would still need a generic layout rule, explicit
proof of field/index correspondence and freshness, and compiled differential
tests across other Pair shapes before production use.
