# Independent Rust batch-settlement baseline

This is a standalone `no_std` SBF implementation of the protocol in
`docs/batch-settlement.md`. `transition.rs` owns the checked totals, authorization,
state transitions and ordered transfers. `wire.rs` independently implements the
canonical published layout. `main.rs` parses SBF accounts, validates token effects
and invokes the original SPL Token Program before committing state.

The account/syscall scaffolding follows the existing independent Rust AMM baseline;
it does not include generated Bend C, Bend runtime headers or the Bend interpreter.
The public layout header is a compatibility constant. The benchmark verifies
byte-identical input fixtures and final account data against the Bend program.

Build with `npm run build:batch-rust`. Run the shared tests with:

```sh
BATCH_PROGRAM=build/batch-rust.so cargo test --locked --test sbf batch_sbf
npm run benchmark:batch
```

Both builds target legacy SBF v0 with the pinned Anza v1.53 tools. Rust uses native
u64 checked arithmetic and ordinary bounded array iteration. This comparison
measures complete equivalent transactions, including the same token CPIs and
validation behavior. It is not a verified Rust implementation or a claim that
these hand-written implementations cover arbitrary Bend programs.
