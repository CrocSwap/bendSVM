# Bend 2 → Solana SBF: initial feasibility

Investigated 2026-09-20. **Recommendation: proceed with a bounded prototype of a restricted, pure Bend backend.** Source inspection supports feasibility, but this investigation has not produced or executed a Bend-generated SBF program. Production suitability remains unproven.

**Subsequent implementation:** the [POC](../README.md) now builds and runs a
restricted Bend escrow transition as SBF in LiteSVM. The initial findings below
are retained as the research baseline; the README records the implemented scope,
tests and measured costs.

## Baseline

- Upstream: [bendlang/bend](https://github.com/bendlang/bend/tree/7561656155a4285c1e4ccfcb3505ab59524de973), commit `7561656155a4285c1e4ccfcb3505ab59524de973`; CLI version `2.0.20`.
- This is Bend 2's dependent/affine language and current C backend. Do not base the project on Bend 1/HVM2 runtime assumptions.
- Local environment: Solana CLI/build-sbf `3.0.15`; build-sbf reports platform-tools `v1.51`; a separate `v1.53` installation is available and was used for the C cross-compilation probe.
- [Anza's platform-tools documentation](https://github.com/anza-xyz/platform-tools#target-architectures) specifically requires v1.53 or newer for its correct SBPFv3 target. Pin the compiler, linker, bytecode version, VM and deployment feature set together; do not assume the default installed build command uses the desired tools.

## Findings

### There is a plausible compilation path

The current [C emitter](https://github.com/bendlang/bend/blob/7561656155a4285c1e4ccfcb3505ab59524de973/bend2/comp.ts#L2948) lowers checked Bend into C. Solana accepts LLVM-produced SBF ELF programs. A freestanding C target is therefore a credible first route; creating a new LLVM backend is unnecessary. This is an architectural inference, not an implemented port.

The existing emitter and runtime are tightly coupled. `compile_book` roots compilation at `main` and includes a runtime template; it does not currently provide an arbitrary pure-function C library interface equivalent to its JS library emitter. Export roots and the calling convention need explicit design.

### The stock runtime cannot simply be cross-compiled

The [runtime template](https://github.com/bendlang/bend/blob/7561656155a4285c1e4ccfcb3505ab59524de973/bend2/comp.ts#L3287) includes pthreads, mmap, signals, host IO and mutable globals. Its allocator, task queues and execution stacks are designed around CPU/GPU lanes. Selecting sequential execution alone does not make these structures fit Solana.

Use an invocation-local context, a bounded arena and deterministic allocation failure. Eliminate worker pools and host effects; reject unsupported effects during compilation. Pure parallel calls can potentially be serialized, but preserve their source semantics and validate the lowering.

Bend already lowers ordinary calls to a flat state machine with explicit continuations. Retaining that mechanism could help avoid deep SBF native call stacks, but its continuation memory must still be bounded. A new direct-call emitter would need its own recursion/stack policy.

Solana documents a single-threaded environment without writable program globals. Its published execution constraints include 32–256 KiB heap requests, 4 KiB stack frames, 64 SBF call frames and a 1.4M CU transaction cap. These are design constraints, not performance targets. Account data is a separate memory resource. Confirm the actual VM/version/feature configuration used for each benchmark. [Limitations](https://solana.com/docs/programs/limitations), [compute budget](https://solana.com/docs/core/fees/compute-budget).

### Arithmetic is a first-class workstream

The pinned [base library](https://github.com/bendlang/bend/blob/7561656155a4285c1e4ccfcb3505ab59524de973/bend2/base.bend) has `Nat`, width-indexed `Word`, and `U32`, but no built-in `U64` or `U128` declarations. A 64-bit runtime term is not a 64-bit numeric type.

Start by evaluating `Word(64)`/limb representations and their generated cost. Add optimized u64/u128 lowering only with a precise relationship to the source arithmetic. Define checked overflow, underflow, division-by-zero and rounding behavior. A conservation equation modulo 2^32 does not establish conservation of economic balances. Native SBF integer support does not automatically make arbitrary-width Bend arithmetic cheap.

## What the proofs would establish

Bend offers dependent types, explicit laws/proofs and checked structural termination; `@unsafe` escapes its guarantees. It also supports erased arguments. Proof checking belongs in the build pipeline; the onchain program need not run a theorem prover. Inspect generated artifacts to verify that specification/proof machinery is actually absent from the exported runtime path. [Language guide](https://github.com/bendlang/bend/blob/7561656155a4285c1e4ccfcb3505ab59524de973/guide/GUIDE.md).

The [Lean model's own opening note](https://github.com/bendlang/bend/blob/7561656155a4285c1e4ccfcb3505ab59524de973/bend2/bend.lean#L1) says it does not fully match `bend.ts` and that implementation bugs could cause inconsistencies. Its core metatheory is valuable evidence, but is not an end-to-end correctness proof for the TypeScript checker, C compiler, runtime or SBF lowering. This review did not independently rerun or audit the Lean development.

The project's trusted components would initially include:

1. The specification and its model of Solana accounts and arithmetic.
2. Bend's implemented elaborator/checker and the correspondence to its formal model.
3. Erasure, optimizations, backend, runtime, LLVM and linker.
4. Account decoding/encoding, authorization checks, syscalls and any CPI assumptions.
5. The deployed binary matching the checked source and build configuration.

Termination does not imply completion within a compute budget. Affine values do not automatically prevent aliasing of external accounts or establish signer/owner/PDA checks. Runtime bytecode verification and reproducible builds address different questions from mathematical verification of a contract's behavior.

## Proposed architecture

```text
Bend implementation + laws + proofs
            ↓ checked and pinned build
restricted pure core → freestanding C → Solana LLVM/linker → SBF ELF
                            ↑
              small C or Rust account/syscall adapter
```

Expose a pure transition shaped like `transition(state, instruction, context) -> Result(state, error)`. The adapter validates account identity, ownership, signer/writable permissions, lengths and duplicate-account behavior, decodes the state, calls the core and writes the result. Initially exclude CPI and variable-size account allocation.

The adapter is initially trusted. Gradually move validation into the modeled transition or establish and test an explicit refinement between bytes/accounts and the Bend model. Every theorem should state its preconditions; the adapter must enforce them.

| Approach | Assessment |
| --- | --- |
| Existing emitter with a small SBF runtime | First experiment; preserves more upstream lowering but may retain excessive runtime overhead. |
| Specialized first-order C emitter over checked/elaborated terms | Strong fallback if the runtime is too expensive; more code-generation work and compiler correctness obligations. |
| New LLVM IR emitter | Possible later; unnecessary complexity before the C path is measured. |
| Onchain Bend/HVM interpreter | Poor starting point because dispatch/allocation consume the transaction budget. |

## Milestones and decision gates

1. **Executable path:** compile a function receiving runtime instruction bytes into an SBF ELF, load it in a pinned VM and return its result. A constant-folded `42` does not pass this gate. Check unsupported imports, ELF sections and stack use.
2. **Verified transfer:** implement a bounded two-balance ledger with u64 semantics. Prove conservation using mathematical balances plus bounds, debit/credit correctness, and rejection on insufficient balance or recipient overflow. Include authorization in the modeled context. This is a local ledger, not yet an SPL Token transfer.
3. **Negative verification:** remove a precondition or introduce an arithmetic defect and require the proof gate to fail. Forbid unsafe dependencies, unresolved holes and unproved laws in the verified build closure.
4. **Execution agreement:** differential-test Bend reference evaluation, generated native code and actual SBF execution over boundary/random inputs. Cover malformed input, duplicated accounts, authorization failures and allocation limits. Differential tests supplement proofs; they do not prove compiler correctness.
5. **Economics:** compare CU use, binary size, peak arena/continuation storage and scaling against an equivalent small Rust program. Set acceptance thresholds around an intended application before broadening the language subset.
6. **Assurance:** inventory the remaining trust assumptions, pin reproducible builds and seek independent review of checker/model correspondence and lowering before a production claim.

Proceed beyond the prototype only if a useful state transition fits the resource budget with acceptable proof effort. If a generic runtime dominates cost, narrow the subset or specialize lowering before adding more SDK features.

## Probe results

[`probes/add.bend`](../probes/add.bend) defines U32 addition and proves commutativity through Base's existing theorem. It validates proof/compiler plumbing, not a financial invariant.

- Check: passed, `All terms check.`
- Reference evaluation: returned `42`.
- C emission and native binary build: passed.
- False-law mutation (`add(a,b) == 0` with the original proof): rejected with an expected/observed equality mismatch.
- Direct platform-tools v1.53 `clang --target=sbf -O2 -c` of stock generated C: failed at missing `math.h`. This is a first header/sysroot failure, not proof of an impossible port or a complete SBF build attempt. Source inspection establishes the deeper runtime dependencies.
- No SBF ELF, VM execution, CU benchmark or end-to-end verified contract was produced.

Reproduce with a checkout at the pinned commit and Bun installed:

```sh
export BEND_NO_TELEMETRY=1
bun /path/to/bend/bend2/main.ts probes/add.bend --check-only
bun /path/to/bend/bend2/main.ts probes/add.bend
bun /path/to/bend/bend2/main.ts probes/add.bend -o /tmp/bendsvm-add.c
bun /path/to/bend/bend2/main.ts probes/add.bend -o /tmp/bendsvm-add-native
/tmp/bendsvm-add-native
```

During this investigation Bun was invoked through `npm exec --yes --package=bun -- bun`; Node alone cannot run the CLI. Upstream source and generated artifacts were kept under `/tmp`, outside this project.
