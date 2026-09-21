# Queue source refinement

`npm run verify:queue` checks 428 claims against the model exported from the
checked queue source. All current positive claims are unsatisfiable negations;
unknown/timeout is rejected. Seven source mutations produce symbolic
counterexamples and different results under direct Bend evaluation. Eighteen
arithmetic-definition/type mutations and three uncovered-protocol-variant
mutations are rejected before proof use.

## Scope

The comparison covers complete source outcomes, including exact state, unchanged
or appended window, logical length, ordered effects and rejection codes. Keys,
amounts, slot, signature, counters, capacities and metadata are symbolic.
Settlement covers every admitted Nat fuel value 0–64, pages one/two, zero and
oversized pages, and mismatched loaded lengths. Remaining state/instruction
combinations cover every protocol constructor, with arbitrary unused payloads.
Selection claims independently compare the source's ranges to nonwrapping
mathematical intervals. Separate lemmas establish nonwrapping cursor/count
progress and widened-integer conservation.

Initialization binds actor and collection. Successful append requires a positive
amount, an empty tail window and available capacity, preserves the old prefix,
and emits the exact funding transfer. Sealing changes phase without effects.
Settlement uses stored obligations in order, emits exact recipient/amount/account
bindings, subtracts each obligation, and advances by precisely the selected page.
The final page closes only with zero remaining obligation. Closed state rejects
further operations. The whole-queue conservation argument is inductive: start at
zero, add each funded obligation, then subtract the exact settled prefix.

## Composition and source binding

The verifier compares queue structure for arbitrary typed add/subtract functions.
It then instantiates those functions with the separately proved checked arithmetic
contracts. Exact transitive function/type bindings ensure those contracts apply
to the source actually imported by the queue. The arithmetic model and proof
report are copied to queue-specific snapshots, avoiding later proof commands
replacing their hashed prerequisites.

The source public-key equality helper is separately evaluated and proved equal
to equality of arbitrary 256-bit keys, then summarized in the transition checks.
Datatype/conditional equality is expanded structurally before SMT; this preserves
exact equality and reduces the solver's datatype search.

For excluded ranges, source guard predicates are normalized only under explicit
case assumptions that make them false. Oversized-page exclusion has its own
proved range lemma. An unused fold result is universally abstracted in rejected
window cases. Valid pages evaluate the actual checked fold and reducer for every
fuel; no queue-specific loop implementation is substituted.

Seven mutations remove owner/collection checks, change recipient or destination
order, lose cursor progress, remove conservation rejection or corrupt funding
amount. Each needs both a symbolic counterexample and a concrete original-versus-
mutated Bend result mismatch. Reports retain replay inputs/results and source,
model, verifier and arithmetic prerequisite hashes.

## Boundary

This establishes source outcomes and their stated arithmetic composition. It does
not prove that account serialization, C/LLVM/SBF lowering, Solana rollback or the
Token Program preserve those outcomes. The checker, exporter, symbolic evaluator,
normalization/composition logic and solver remain trusted. Canonical storage,
account authorization/alias checks and transaction effects have separate native
sanitizer and SBF tests. Shared Rust conformance and benchmarks provide additional
execution evidence, not a compiler proof.

The source accepts runtime context and windows supplied by the adapter; the
adapter's account/window contract is therefore part of the application argument.
No live-cluster deployment or worst-case compute bound is established here.
