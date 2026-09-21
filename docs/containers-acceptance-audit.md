# Generic containers and bounded iteration acceptance review

Status: accepted. The full regression passed with **68 tests, zero failures and
two benchmark tests excluded from the default run**. All **15
source refinement commands** passed. The required batch benchmark separately
passed shared conformance and 18 matched operations. The final evidence audit
validated current source/artifact hashes, fixture metrics, reproducibility and
all proof reports, and wrote `build/containers-acceptance.json`.

The objective and all eight acceptance requirements are preserved in
[containers-plan.md](containers-plan.md). The implementation supports a bounded
Bend subset, with application logic in Bend and no batch-specific compiler paths.

| Requirement | Implementation and evidence | Result |
| --- | --- | --- |
| Generic data and functions | Backend specialization of erased type parameters; nested and multiple record/union instances; 37 Bend/native/SBF cases, 11 source-model claims and two mutations | Passed |
| Bounded containers | `sdk/buffer.bend` supplies runtime length, checked access/update/append and storage adapters; Bool/two-slot and U32/four-slot fixtures; 181 differential cases, seven claims and four mutations | Passed |
| Bounded iteration | `sdk/iteration.bend` specializes generic state/step functions; structural Nat tail recursion emits loops with simultaneous argument updates; 325 differential cases across all 65 fuels; growing, oversized, wrong-fuel and non-tail programs rejected | Passed |
| Source semantics and proofs | Exported specialization identities, bounded recursion and unreachable-path checks; three fold contracts cover every fuel with arbitrary payloads; batch refinement passes 788 claims and seven mutants with concrete Bend replays, composing exact checked arithmetic with arbitrary-update structural traversal | Passed |
| Batch settlement | Immutable funded obligations; signed owner authorization; positive checked totals; exact custody/recipient bindings; ordered real token transfers; terminal state and rollback; 120 outcome-oracle cases and seven transaction tests | Passed |
| Independent Rust baseline | Standalone Rust arrays/checked arithmetic, wire decoder, state transition and token adapter; identical protocol; same seven real-token conformance tests | Passed |
| Fair benchmark | Eighteen identical transactions/account fixtures, both SBF v0 targets, same LiteSVM/Token Program; exact post-state/errors and repeated CU reports compared; source/toolchain/artifact hashes | Passed |
| Regression and external workflow | Existing vault/vesting/exchange/AMM applications retained; generated interfaces/client; independent public builds and fresh-output reproducibility comparisons pass, with all five application manifests current; documented commands below | Passed |

The five new differential fixtures cover 1,755 Bend/native/SBF cases in total:
37 generic, 181 buffer, 325 iteration, 1,092 fold and 120 batch outcomes. SBF
transaction tests additionally cover real token effects and atomic rollback.
The independent Rust implementation passes the same seven batch lifecycle tests;
settlement on the matched fixtures costs about 2.00–2.06 times Rust. These are
observed transaction costs, not worst-case bounds.

## Reproduce the acceptance gates

With the pinned prerequisites from the README installed:

```sh
mkdir -p build
npm test > build/containers-regression.log 2>&1
npm run verify:all > build/containers-refinement-suite.log 2>&1
npm run benchmark:batch
node_modules/.bin/bun scripts/audit-containers.ts
```

Honor each command's exit status. The final script rejects missing or stale
refinement reports, altered source hashes, incomplete suites, missing mutation
counterexamples and mismatched benchmark artifacts. It writes
`build/containers-acceptance.json` only after its evidence checks pass. That script
checks evidence consistency; this written review separately identifies what each
test and proof actually establishes.

Individual commands and semantics are documented in [containers.md](containers.md),
[iteration.md](iteration.md), [batch-settlement.md](batch-settlement.md),
[batch-refinement.md](batch-refinement.md) and [batch-benchmark.md](batch-benchmark.md).

## Scope and trust boundary

Supported containers have fixed bounded backing storage and runtime logical
lengths. The batch has one to four obligations. Nat fuel is 0–64 and only the
documented structurally decreasing tail-recursion pattern is lowered. Custom
storage adapters and reducers require their own contracts. The compiler's native
value, canonical wire and SBF stack limits remain in effect.

The batch proof establishes full source outcomes through an explicit arithmetic
composition. It does not prove that C/LLVM/SBF lowering, the account adapter,
Solana runtime or external token program preserves those outcomes. The checker,
model exporter, symbolic evaluator, composition and solver are trusted; native
sanitizer tests, SBF execution, Rust conformance and reproducible builds supply
separate evidence. No unrestricted Bend compatibility, worst-case compute bound,
production security audit or end-to-end verified deployed binary is claimed.
