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
| Fund 1 obligation | 36,998 | 14,555 | 2.54× |
| Fund 4 obligations | 37,229 | 14,603 | 2.55× |
| Settle 1 obligation | 30,791 | 14,915 | 2.06× |
| Settle 2 obligations | 45,469 | 22,587 | 2.01× |
| Settle 3 obligations | 60,567 | 30,262 | 2.00× |
| Settle 4 obligations | 76,089 | 37,942 | 2.01× |
| Reject unauthorized settlement | 21,980 | 6,992 | 3.14× |
| Roll back at frozen fourth destination | 71,603 | 36,085 | 1.98× |

ELF sizes are 30,128 bytes for Bend and 30,520 bytes for Rust. Additional measured
cases cover replay at each length, empty input, mismatched fuel, overflow and
insufficient funding. Complete numbers and fixture hashes are in
`build/batch-benchmark.json`; raw fixture/account records are retained beside it.

These measurements show the current cost of full transactions on these fixtures,
not a general language-performance ratio or a worst-case compute guarantee.
The matched benchmark, universal batch refinement and complete regression suite
are accepted in the [container milestone audit](containers-acceptance-audit.md).
