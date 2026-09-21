# Bounded runtime iteration

`sdk/iteration.bend` defines `repeat` with a compile-time state type and step
function, a runtime `Nat` fuel value, and an initial state. Each successor consumes
one unit of fuel and applies the step once; zero returns the state unchanged.

The backend lowers this checked structural recursion to a C loop with simultaneous
argument updates. Exported roots and loop functions are kept out of caller inline
frames so large generic state does not exhaust the SBF stack-frame limit. It does not emit recursive SBF calls or expand the source into
a fixed sequence of step calls. The step specializes to a first-order function;
there are no runtime closures. Optimizations may simplify individual loops when
their behavior permits it.

## Accepted subset

- Pinned Base `Nat` has a compact four-byte unsigned representation in this target,
  with an explicit maximum of **64** in its generated schema.
- Client and generated C codecs reject larger values, including values nested
  within records. SBF receives only validated values through the generated adapter.
- Source literals are limited to 0–64. Runtime successor construction is rejected;
  existing values, predecessors, and bounded literals preserve the domain.
- Direct self recursion must be in tail position. Every recursive branch must
  pass a strict structural predecessor of the function's first `Nat` argument
  back to that same argument position. The backend tracks this provenance.
- Non-tail recursion, mutual recursion and other recursive runtime data remain
  unsupported. Calls hidden inside local expressions are not converted into
  tail calls. These conservative restrictions can be expanded separately.

These rules bound each supported loop to at most 64 iterations. Nested loops can
multiply work; the limit is not a transaction-wide compute guarantee. Generated
C functions assume validated typed inputs, as do the other runtime types.

`Nat` in unrestricted Bend has no such finite bound. The SBF target deliberately
accepts a bounded representation and rejects programs that can grow it at runtime.
Source refinement claims apply to this admitted domain; they do not change the
meaning of unrestricted Bend naturals.

## Verification

`npm run test:iteration` compares 325 cases across Bend evaluation, generated C
with sanitizers and SBF execution. Every fuel value 0–64 is exercised. Fixtures
cover wrapping arithmetic, generic record state, Bool state and simultaneous
updates of multiple arguments. Generated headers are checked for loop emission.
Additional SBF transactions verify rejection of excessive fuel, and compiler
negatives reject oversized literals, runtime successor construction and non-tail
recursion.

`npm run verify:iteration` proves the four fixture contracts for arbitrary state
payloads at every admitted fuel value. The checked-source model keeps natural
constructors and matches semantically distinct from U32 arithmetic. The symbolic
evaluator bounds recursive expansion and records any exhausted bound as an
unreachable-path obligation; it never silently treats exhaustion as success.
Two source mutations must produce concrete solver counterexamples.

The checks do not verify the compiler implementation or establish arbitrary step
function invariants. Vector-fold conservation and settlement effects require
their own source contracts and execution tests in the current milestone.
