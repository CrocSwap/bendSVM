# Queue Bend/Rust benchmark

The independent Rust baseline passes the same four queue conformance tests as
Bend. The benchmark compares 26 matched operations, including capacities 2/64/256,
page sizes one/two, initialization, funding, sealing, replay and rejected operations.
Both programs target SBF v0 and execute with the same LiteSVM and Token Program.
Every recorded instruction, account fixture, post-state and error matches, and
both sets of compute measurements repeat identically.

| Operation | Bend CU | Rust CU | Bend/Rust |
| --- | ---: | ---: | ---: |
| Initialize capacity 2 | 15,546 | 6,483 | 2.40 |
| Initialize capacity 64 | 31,542 | 22,479 | 1.40 |
| Initialize capacity 256 | 81,078 | 72,015 | 1.13 |
| Append one (all tested capacities) | 31,712 | 13,026 | 2.43 |
| Settle first page, one record | 32,798 | 13,402 | 2.45 |
| Settle first page, two records (capacity 64/256) | 48,264 | 21,159 | 2.28 |
| Settle final page, one record | 31,672 | 13,295 | 2.38 |
| Late frozen destination rollback | 42,589 | 19,116 | 2.23 |
| Replay | 12,598 | 2,775 | 4.54 |

The Bend ELF is 35,192 bytes; Rust is 31,696 bytes. Rust's build is reproduced
byte-for-byte using the pinned Anza platform-tools Rust compiler. Manifests record
source, toolchain and artifact identities. `build/queue-benchmark.json` contains
all rows, fixture hashes and build manifests; the raw reports preserve inputs and
outputs for comparison.

These are observed fixture costs, not worst-case bounds. Bounded append/page costs
do not grow with allocation capacity in these measurements. Initialization scans
all bytes in both implementations, so its cost does grow with capacity. Cheap
rejections have larger ratios than successful token operations. No performance
parity is claimed.

Reproduce with `bun scripts/benchmark-queue.ts`. It rebuilds both programs, runs
shared conformance, repeats each benchmark and rejects any mismatch. The baseline
is ordinary Rust with independent codecs, transitions, account checks and token
adapter; it does not reuse generated Bend C. See benchmarks/queue-rust/README.md.
