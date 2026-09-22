# bendSVM

A bounded **Bend 2 → Solana SBF** compiler and shared SDK, exercised by a token
vault, linear vesting contract, fixed-price exchange and constant-product AMM.
All four use the same
compiler, generated interfaces and runtime, with their business rules in Bend.
No application-specific C or compiler branches are required. The shared-application
milestone has passed its [final acceptance audit](docs/acceptance-audit.md).

The constant-product AMM milestone has also passed its
[acceptance audit](docs/amm-acceptance-audit.md), including source refinements and
a matched [Rust SBF benchmark](docs/amm-benchmark.md).

The [batch-settlement application](docs/batch-settlement.md) now exercises generic
vectors, bounded runtime iteration and fallible folds. Its independent Rust
implementation passes shared conformance and a [matched benchmark](docs/batch-benchmark.md).
Its [source refinement](docs/batch-refinement.md) passes 788 obligations and seven
mutation checks. The generic-container and bounded-iteration milestone has passed
its [acceptance audit](docs/containers-acceptance-audit.md).

The [paged queue](docs/queue-settlement.md) uses larger account-backed collections,
funds obligations atomically and settles bounded pages across transactions. It has
[source invariants](docs/queue-refinement.md), an independent Rust baseline and a
[26-operation benchmark](docs/queue-benchmark.md). The account-collection milestone
has passed its [acceptance audit](docs/account-collections-acceptance.md).
Builds now provide [target diagnostics and resource reports](docs/diagnostics.md).

Bend checks the source and laws. The backend lowers checked runtime terms to
freestanding C; pinned Anza Clang/LLD produce SBF ELF programs executed in LiteSVM.
Separate SMT refinement checks cover arithmetic and all six application source transitions.
This is a documented language subset, not full Bend compatibility or an
end-to-end verified compiler/deployed binary.

## Applications and SDK

| Application | Implemented behavior |
| --- | --- |
| [Vault](docs/vault.md) | Initialize, deposit and withdraw real test tokens; owner authorization and checked u64 accounting |
| [Vesting](docs/vesting.md) | Atomic funding, runtime-slot entitlement, beneficiary claims, full-precision arithmetic and completion |
| [AMM](docs/amm.md) | Constant-product pool, transferable LP shares, deposits/withdrawals and bidirectional swaps; source refinements and matched Rust SBF measurements |
| [Exchange](docs/exchange.md) | Funded fixed-price offers, partial fills, per-fill ceiling pricing, maximum-payment limits, cancellation and atomic two-token settlement |
| [Paged queue](docs/queue-settlement.md) | Account-backed obligations, atomic funded appends, bounded settlement pages, persistent progress and replay prevention |
| [Batch settlement](docs/batch-settlement.md) | Fund one to four immutable obligations and settle them atomically using generic vectors and bounded folds; source invariants and matched Rust benchmark |

The SDK provides generated canonical codecs, signed initialization, actor/clock
context, one to four managed state accounts, PDA custody, original SPL Token
transfers, custody-controlled mint/burn, three atomic token effects and [bounded arbitrary-program CPI](docs/cpi.md). Multi-state tests
exercise atomic updates, token transfers and rollback. Generic CPI tests cover
actor/PDA signatures, two-call rollback and external account grow/shrink behavior.
Cross-application tests compose purchases, vault operations and vesting funding.

See the [supported subset](docs/subset.md), [interfaces](docs/interfaces.md),
[arithmetic semantics](docs/arithmetic.md) and [acceptance audit](docs/acceptance-audit.md).

## Build and test

For a new program, use the [developer workflow](docs/developer-workflow.md) after
installing the prerequisites below:

```sh
npm run bend -- new projects/my-program
npm run bend -- check projects/my-program
npm run bend -- verify projects/my-program
npm run bend -- build projects/my-program
npm run bend -- test projects/my-program
```

The starter includes an authorized collection, declared laws, proofs and offline
SBF tests. Builds emit portable typed clients; no handwritten C or instruction
encoding is needed.
The workflow has passed its [acceptance review](docs/developer-workflow-acceptance.md).
The supported [external experimental alpha setup and live-validation workflow](docs/external-alpha.md)
adds a doctor, pinned TypeScript packaging check, isolated acceptance gate and
fresh-key local/devnet deployment runner. It is not production-safe.

Prerequisites:

- Node/npm and Git; `npm ci` installs Bun **1.4.2** and TypeScript **5.2.2**.
- Rust/Cargo, tested with **1.92.0**, for LiteSVM tests.
- Host Clang for native sanitizer/differential tests (`CC` overrides it).
- [Anza platform-tools v1.53](https://github.com/anza-xyz/platform-tools/releases/tag/v1.53),
  normally at `~/.cache/solana/v1.53/platform-tools/llvm/bin`; `SBF_TOOLS` overrides it.
- Python/Z3 is optional for the ordinary alpha workflow. Refinement checks use
  `PYTHON` and a binding reporting **5.1.0**; provision it in a virtualenv as
  documented in [external-alpha.md](docs/external-alpha.md).

```sh
npm ci
npm test
```

`npm test` runs source-law mutations, Bend/reference/native/SBF comparisons,
canonical codec checks, application lifecycles, adversarial transactions, CPI
integration and reproducible builds. `verify:all` runs all seventeen separate source
refinement commands and writes `build/refinement-suite.json`; it is optional and
requires the pinned Z3 virtualenv described above. See
[refinement.md](docs/refinement.md) for their assumptions and negative checks.

For the external-alpha setup, run `npm run bootstrap:alpha` followed by
`npm run doctor`; `npm run acceptance:alpha` reproduces the isolated staged
starter and source-law failure gate. Use `npm run doctor -- --refinement` only
after provisioning the optional pinned Z3 virtualenv. The acceptance record
distinguishes clean-source validation from reused platform-tools/Cargo caches.

`npm run acceptance:developer` exercises a real application change in a staged
source copy: reject zero-valued appends, add a declared law and proof, check a
deliberate violation, and execute the repaired program in LiteSVM. Follow the
[tutorial](docs/external-alpha-tutorial.md) for the corresponding source and test
edits. This automated gate is separate from an independent developer trial.
With a [local validator](docs/local-testing.md) running, extend that result with
`npm run acceptance:developer:local`. Individual projects can run their same
`test.ts` using `npm run bend -- test <project> --local-rpc http://127.0.0.1:18899`.
See the [fresh-developer acceptance record](docs/fresh-developer-acceptance.md)
for executed checks and their limits.

Build an application independently:

```sh
npm run build:program -- examples/vault/PROOF.bend vault.process build/vault
npm run build:program -- examples/vesting/PROOF.bend vesting.process build/vesting
npm run build:program -- examples/exchange/PROOF.bend exchange.process build/exchange
npm run build:program -- examples/amm/PROOF.bend amm.process build/amm
npm run build:program -- examples/batch/PROOF.bend batch.process build/batch
```

The optional fourth argument is a [multi-state layout JSON file](docs/interfaces.md).
Outputs include `.so`, generated C/headers, schemas, interfaces and a source/artifact
SHA-256 manifest. The build checks the pinned, clean Bend checkout at commit
`7561656155a4285c1e4ccfcb3505ab59524de973`. It targets **SBPFv0** with
`--target=sbf -mcpu=generic`, tested against pinned LiteSVM 0.7.1 / Agave 2.3.
No wallet, RPC connection or public deployment is needed.

## Boundaries

Runtime code supports first-order nonrecursive functions, concrete records/ADTs,
U32/Bool primitives, checked u64 arithmetic and full-precision intermediate products.
Initial compile-time specialization of generic records, unions and functions is
covered by `npm run test:generics`, including source-model checks. Reusable bounded vectors now have checked access, update and append operations,
covered by `npm run test:buffer` and `npm run verify:buffer`. Bounded Nat-fueled
iteration is covered by `npm run test:iteration` and `npm run verify:iteration`.
Generic fallible folds and runtime-length token effect vectors are described in
[containers](docs/containers.md). The batch demonstration and complete evidence
are recorded in the [container milestone audit](docs/containers-acceptance-audit.md).
Direct structurally decreasing Nat tail recursion lowers to loops; other runtime
recursion, unresolved generic runtime data, closures, dynamic collections,
heap allocation and parallel scheduling remain unsupported. Unsupported constructs fail compilation.
C values are limited to 1,536 bytes, canonical wire values to 1,024 bytes, and SBF
stack frames to 4,096 bytes. Each new program must fit its execution budget.

Proof functions are checked before compilation and erased from the runtime
closure. The checker, model exporter, proof drivers, primitives, backend, LLVM,
account adapter and external programs remain trust assumptions. Source proofs and
SMT results do not prove that the deployed binary or an arbitrary CPI callee is
correct. Runtime tests and reproducible builds supply separate evidence.

The [initial feasibility review](docs/feasibility.md) and
[historical escrow POC](docs/escrow-poc.md) preserve the project's starting point.

## License

Project-owned source code is licensed under the GNU General Public License,
version 3 only (`GPL-3.0-only`). See [LICENSE](LICENSE) for the complete text.
Third-party dependencies and upstream code remain under their respective
licenses; this project does not relicense them.
