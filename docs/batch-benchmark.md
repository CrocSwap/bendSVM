# Matched batch-settlement benchmark

`npm run benchmark:batch` builds both implementations, runs the same seven
real-token conformance tests against each, and measures 18 fixed-fixture
operations twice. It requires identical instruction bytes, account inputs,
post-state bytes and errors, and byte-identical repeated measurement reports.
The final report records fixture/artifact/source hashes and toolchain manifests.

The Bend implementation is ordinary source using generic vectors, bounded
iteration and a fallible fold. The independent Rust implementation uses u64
checked arithmetic, arrays and a hand-written equivalent account/token adapter.
Both target SBF v0/generic on the pinned Anza toolchain and execute in the same
LiteSVM version with the original SPL Token Program.

| Operation | Bend CU | Rust CU | Bend / Rust |
| --- | ---: | ---: | ---: |
| Fund 1 obligation | 18,770 | 14,555 | 1.29× |
| Fund 4 obligations | 19,001 | 14,603 | 1.30× |
| Settle 1 obligation | 16,767 | 14,916 | 1.12× |
| Settle 2 obligations | 25,620 | 22,588 | 1.13× |
| Settle 3 obligations | 34,566 | 30,263 | 1.14× |
| Settle 4 obligations | 43,609 | 37,943 | 1.15× |
| Reject unauthorized settlement | 6,289 | 6,993 | 0.90× |
| Roll back at frozen fourth destination | 41,753 | 36,086 | 1.16× |

These results were refreshed on 2026-10-03 using the public benchmark command.
Both implementations passed all seven shared conformance tests; all 18 matched
cases reproduced identical CU readings. The Rust codec's stale state-header
constant was updated to the published interface, and its build now refuses a
header or size mismatch before compiling. Its transition and codec algorithms
were unchanged. The source/artifact and outcome audit is
`build/batch-refresh-20261003/audit.json`; preceding artifacts and the initial
header-mismatch failure are retained in that directory.

The earlier documented Bend costs were 36,998 CU for funding one obligation
and 76,089 CU for settling four. Current costs are 49.3% and 42.7% lower,
respectively. This refresh measures accumulated compiler/SDK improvements;
it does not attribute those savings to an individual optimization.

ELF sizes are 28,296 bytes for Bend and 30,536 bytes for Rust. Additional measured
cases cover replay at each length, empty input, mismatched fuel, overflow and
insufficient funding. Complete numbers and fixture hashes are in
`build/batch-benchmark.json`; raw fixture/account records are retained beside it.

These measurements show the current cost of full transactions on these fixtures,
not a general language-performance ratio or a worst-case compute guarantee.
The matched benchmark, universal batch refinement and complete regression suite
are accepted in the [container milestone audit](containers-acceptance-audit.md).
