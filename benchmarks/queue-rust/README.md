# Independent Rust queue baseline

This is a standalone `no_std` SBF program implementing the published queue protocol.
`transition.rs` uses native checked u64 arithmetic and a two-record array;
`wire.rs` implements the canonical ABI directly. `main.rs` independently validates
accounts, collection ranges, proposed writes and token effects, committing state
only after successful CPIs. The loader/token scaffolding is adapted from the
existing independent Rust batch baseline. No generated Bend C is linked or called.

Schema header constants identify the same published state/element layouts as the
Bend implementation. Sharing these protocol identifiers is required for identical
input fixtures; decoding and transition implementations remain independent.

Build with `bun scripts/build-queue-rust.ts`. The script pins the Anza platform-tools
Rust/LLVM versions, emits SBF v0, checks imports and verifies byte-identical rebuilds.
Use `QUEUE_PROGRAM=build/queue-rust.so cargo test --locked --test sbf queue_sbf`
to run the shared conformance fixtures. `bun scripts/benchmark-queue.ts` builds
both implementations and runs conformance plus repeated matched benchmarks.
