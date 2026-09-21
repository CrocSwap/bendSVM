# Batch source refinement

Status: passed. `build/batch-refinement.json` records 788 proved obligations,
seven symbolic counterexamples with concrete Bend mutation replays, 14 rejected
arithmetic-binding changes and rejection of uncovered protocol variants. The
complete milestone passed its [acceptance audit](containers-acceptance-audit.md).

Run `npm run verify:batch` to regenerate this evidence, including its arithmetic
prerequisite. The driver retains dedicated arithmetic model/report snapshots so
later arithmetic runs cannot replace the evidence used by this composition.

The verifier exports the checked source closure of `process` and `sum` from
`examples/batch/batch.bend`. Its expected outcomes are separate specifications of
funding, settlement and rejection. It compares the complete outcome: state,
immutable batch fields, token effect count, each effect's source/destination/mint,
recipient, amount, authority and exact account binding.

## Composition

The proof uses two explicit boundaries rather than expanding every limb operation
inside every fold iteration:

1. Reprove checked u64 arithmetic. Bind the batch's imported `Math.add` function,
   helpers and types to that exact checked arithmetic model before using its
   specified addition result.
2. Prove the batch's `add_amount` source contract for arbitrary checked accumulator
   and u64 amount: existing errors persist, zero amounts fail with code 3,
   overflow fails with code 4, and successful addition is exact. Prove the
   corresponding wide-prefix preservation identity separately.
3. Prove the complete transaction structure for **every** function of type
   `Checked × U64 → Checked`, using an uninterpreted update function for
   `add_amount`. The independent expected fold applies that same function once
   per active obligation, in order, starting from zero. This stronger structural
   theorem can be instantiated with the verified concrete `add_amount` function.

The zero base case and the proved step invariant connect the ordered recurrence
to conservation of the exact mathematical sum. The concrete update's absorbing
error behavior and positive-amount check ensure an accepted final result has no
zero or overflowing prefix. No unproved summary of an entire batch is assumed.

## Bounds and inputs

Fuel is checked for every admitted Nat value, 0–64. Logical U32 lengths are split
into 0, 1, 2, 3, 4 and the complete out-of-range domain `length > 4`. For that last
domain, a separately proved unsigned-comparison fact allows the evaluator to
simplify the capacity test to false. The case assumption is retained in the
solver obligation; it is not applied to valid-length cases.

The verifier checks all key and amount payloads symbolically, signer/owner
conditions, stored-total agreement, immutable obligations, ordered effects and
terminal-state behavior. It also proves the recorded unreachable paths are
unreachable on the admitted inputs. Nat bounds, storage capacities, and the
exact arithmetic binding are part of the checked proof inputs.

## Negative evidence and trust boundary

Mutation checks cover removed signer/owner checks, changed recipients, changed
amounts, incorrect destination order, removed conservation checks and incorrect
total accumulation. Each must produce a symbolic counterexample and a concrete
mismatch replayed through the pinned Bend evaluator. Because the structural
proof quantifies over arbitrary update functions, its SMT witness may use a
nonconcrete update interpretation; the separate concrete replay demonstrates
that the actual mutated Bend implementation also violates the contract.

The driver additionally corrupts each imported arithmetic function and type and
requires binding failure. Adding an unhandled state, instruction or outcome
variant must also fail before solving. These guards prevent source evolution
from silently invalidating the arithmetic composition or dispatch case split.

The checked-source exporter, arithmetic primitive model, proof driver,
compositional reasoning and Z3 remain trusted. This is not verification of C/SBF
lowering or external token-program behavior. Native/SBF differential execution,
real token lifecycle tests, matched Rust conformance and reproducible builds
provide separate evidence for those parts.
