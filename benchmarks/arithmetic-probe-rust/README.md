# Arithmetic SBF probe baseline

This independent Rust SBF program implements the arithmetic probe's fixed
17-byte input and 12-byte return-data contract. Run the matched Bend/Rust
LiteSVM probe from the repository root with:

```sh
npm exec -- bun scripts/benchmark-arithmetic-probe.ts
```

The program has no accounts or CPIs. Its CU results cover a minimal SBF
instruction, the selected arithmetic operation, return-data handling, and
LiteSVM transaction overhead. They are useful for localizing arithmetic cost;
they do not predict application transaction costs or establish broad CU parity.
