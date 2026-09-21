# Supported Bend/SBF subset

This target compiles a bounded, first-order subset of checked Bend 2. The vault,
vesting contract, fixed-price exchange, AMM and batch settlement use the same backend and SDK. This is
not full Bend language/runtime compatibility.

## Runtime language

Supported forms include pinned Base U32/Bool values and whitelisted arithmetic,
concrete nonrecursive records/tagged unions, erased-type generic specialization,
field pattern matching, constructor
construction, local expression bindings and fully applied function
calls and [bounded Nat-fueled tail recursion](iteration.md). Reusable data bindings use Bend's normal checked usage rules. Export
roots are explicit; only their runtime call closure is emitted.

The SDK expresses u64 values as two U32 limbs and u128 intermediate products as
two u64 values. Checked arithmetic, full-precision floor/ceiling multiply/divide,
public-key equality and application rules are ordinary Bend definitions. Their
names receive no compiler special treatment. See [arithmetic.md](arithmetic.md)
for exact wrapping, overflow, underflow, division and rounding semantics.

Unsupported runtime forms fail compilation: recursion outside the bounded Nat
tail-recursion subset, recursive data other than bounded Nat, unresolved generic parameters or
dependent runtime types, higher-order functions/closures, partial application,
floating point, runtime proof arguments, heap-allocated dynamic arrays and host IO.
There is no Bend parallel scheduler, heap allocator or mutable program-global
state. Fixed computations such as division still use bounded function composition.

Compile-time generic functions use the pinned checker's specialization. Generic
records/tagged unions currently support erased type parameters, concrete
nonrecursive instances, and nested instances. `npm run test:generics` compares
37 cases against Bend evaluation, native sanitizer execution and SBF execution;
it also checks 11 universal source-model properties and two source mutations.
The model preserves specialized constructors and match branches. This initial
coverage does not establish arbitrary generic compatibility: value/capacity
parameters in runtime types remain unsupported. Bounded iteration now uses
0–64 Nat fuel values with checked structural descent.
The [bounded-vector library](containers.md) supports runtime lengths and generic
storage adapters specialized at compile time. Two capacities and element types
are covered by differential execution and source-model refinements.

Account-backed collections now support larger allocations through bounded typed
windows, with generic reads/updates/appends, a generated ABI-3 adapter and client.
The whole collection is never materialized as one native value. The per-call
window still obeys the same value/stack bounds. See [collection storage](collection-storage.md),
[queue settlement](queue-settlement.md) and [target diagnostics](diagnostics.md).

Full Bend can express proofs, subject to the checked build's rejection of open
laws, unresolved holes and unsafe/foreign dependencies. Proof functions are
checked before lowering and do not enter the emitted runtime closure.

## Resource and interface bounds

| Resource | Current limit |
| --- | --- |
| Arguments per runtime function | 8 |
| Nat fuel value / iterations per structurally decreasing loop | 64 |
| Native C value size | 1,536 bytes |
| Canonical wire value size | 1,024 bytes |
| Constructors per wire type | 256 |
| Pure-dispatch instruction size | 1,024 bytes |
| Stateful account count | ABI 1: 2 without effects, 4–12 with token effects; ABI 2: state count + actor (+ token program/custody), at most 12 with effects |
| Effect slots per state transition | Fixed records: 2–3; Pair-backed token vectors: capacity 2, 4 or 8, subject to value/stack limits |
| Mutable application state accounts per call | ABI 1: one; ABI 2: 2–4; ABI 3: small state plus one collection |
| SBF native stack frame | Clang checks the 4,096-byte target limit |

The account SDK provides canonical fixed-size storage, signed allocation
initialization, runtime actor/signature/slot context, application errors and
state-specific custody PDAs. Token effects support the original SPL Token
Program's checked transfers, mint validation and custody-controlled mint/burn. Token-2022, wrapped SOL,
delegated source authority, account resizing, PDA account creation are not yet supported by the specialized token SDK.
A separate bounded [CPI family](cpi.md) targets arbitrary executable programs;
its two-call, multi-state and external-resize integration is tested. Clients create allocations and token accounts
using standard System/Token instructions. See [interfaces.md](interfaces.md).

These are explicit implementation bounds, not proven maximum compute costs.
Every new program must still compile within the target stack/bytecode constraints
and execute within its transaction compute budget.

## Public build and reproducibility

After `npm ci`, with the README prerequisites installed:

```sh
npm run build:program -- examples/vault/PROOF.bend vault.process build/vault
npm run build:program -- examples/vesting/PROOF.bend vesting.process build/vesting
npm run build:program -- examples/exchange/PROOF.bend exchange.process build/exchange
```

The command fetches/verifies the pinned clean Bend checkout, checks source/laws,
emits typed interfaces and the shared state adapter, compiles with the pinned
Anza toolchain and rejects unknown unresolved imports. No application C is
required. The output stem gets `.so`, `.c`, `.h`, `.schema.json`, `.interface.json`,
`.wire.h`, `.dispatch.h`, `.resources.json`, `.stack.json` and `.manifest.json` files. Build failures are errors;
callers must honor the command's exit status.

The manifest records the Bend commit, Bun/compiler versions, SBF target, export
root, emitted functions and SHA-256 hashes for loaded Bend sources, local compiler
and runtime support, build scripts, package metadata and generated artifacts.
Runtime/compiler file hashing is conservative and includes unused support files.
The clean pinned Bend commit covers the upstream implementation and Base library.

`tests/builds.ts` compares the public build's ELF with the test build, then builds
each application into a fresh output directory and compares all generated
artifacts and the complete manifest. `build/reproducibility.json` records the
results. This tests deterministic rebuilds on the pinned local toolchain; it
does not establish reproducibility across arbitrary hosts or toolchain versions.

## Remaining assurance work

Checked application laws prove the stated source properties. Independent oracle,
native sanitizer and signed SBF tests check arithmetic, lowering, serialization,
authorization and external token effects. The implemented checker, backend,
LLVM/linker, adapter, syscalls and Token Program remain trusted components.
The separate [refinement command](refinement.md) establishes checked u64
add/subtract/comparison and u64 division relative to modeled U32 primitives.
A separate compositional multiplication check covers checked u64 multiplication
and exact 128-bit products. `verify:wide` checks wide division and floor/ceiling
multiply-divide using those product and division-loop prerequisites. The [final acceptance audit](acceptance-audit.md) records the completed
shared-application milestone. The [container milestone audit](containers-acceptance-audit.md)
records accepted generic containers, bounded iteration and batch settlement.
The project must not claim end-to-end verified
deployed binaries on the basis of these tests and source proofs.
