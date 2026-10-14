# Queue Bend/Rust benchmark

The independent Rust baseline passes the same four queue conformance tests as
Bend. The benchmark compares 26 matched operations, including capacities 2/64/256,
page sizes one/two, initialization, funding, sealing, replay and rejected operations.
Both programs target SBF v0 and execute with the same LiteSVM and Token Program.
Every recorded instruction, account fixture, post-state and error matches, and
both sets of compute measurements repeat identically.

| Operation | Bend CU | Rust CU | Bend/Rust |
| --- | ---: | ---: | ---: |
| Initialize capacity 2 | 8,723 | 6,483 | 1.35 |
| Initialize capacity 64 | 24,719 | 22,479 | 1.10 |
| Initialize capacity 256 | 74,255 | 72,015 | 1.03 |
| Append one (all tested capacities) | 15,143 | 13,026 | 1.16 |
| Settle first page, one record | 16,242 | 13,402 | 1.21 |
| Settle first page, two records (capacity 64/256) | 25,550 | 21,159 | 1.21 |
| Settle final page, one record | 15,888 | 13,295 | 1.20 |
| Late frozen destination rollback | 22,173 | 19,116 | 1.16 |
| Replay | 2,541 | 2,775 | 0.92 |

The public benchmark command refreshed these measurements on 2026-10-03.
Both implementations passed four shared conformance tests and all 26 matched
cases reproduced their CU readings. Source/artifact hashes and raw outcomes
were audited in `build/queue-refresh-20261003/audit.json`; earlier outputs are
preserved in its `previous` directory. No Rust baseline changes were needed.
The old documented append and one-record first-page costs were 31,712 and
32,798 Bend CU. The new figures are 52.2% and 50.5% lower, reflecting accumulated
compiler/SDK changes rather than an isolated optimization experiment.

The Bend ELF is 33,664 bytes; Rust is 31,696 bytes. Rust's build is reproduced
byte-for-byte using the pinned Anza platform-tools Rust compiler. Manifests record
source, toolchain and artifact identities. `build/queue-benchmark.json` contains
all rows, fixture hashes and build manifests; the raw reports preserve inputs and
outputs for comparison.

These are observed fixture costs, not worst-case bounds. Bounded append/page costs
do not grow with allocation capacity in these measurements. Initialization scans
all bytes in both implementations, so its cost does grow with capacity.
Rejection costs vary: replay is cheaper than Rust on these fixtures, while bad
fuel costs 1.31× Rust. No general performance parity is claimed.

Reproduce with `bun scripts/benchmark-queue.ts`. It rebuilds both programs, runs
shared conformance, repeats each benchmark and rejects any mismatch. The baseline
is ordinary Rust with independent codecs, transitions, account checks and token
adapter; it does not reuse generated Bend C. See benchmarks/queue-rust/README.md.
