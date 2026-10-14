# Isolated type evaluation

`Backend.type` and generic specialization evaluate checked type terms through
`isolatedTypeWhnf`. The pinned Bend evaluator memoizes by changing `Var.i` and
`Var.v`; a shared cell could therefore make later type queries depend on query
order. The wrapper copies the input graph and lazily copies declarations reached
through `book.tlds`, so those writes stay in the private graph.

While pinned `term_wnf` is running synchronously, wrapped binder arguments are
recursively marked as owned. This preserves nested memo-cell sharing, including
cells below constructor values created by the evaluator. If a returned binder is
called later, its external arguments are copied before it runs. Copy traversal
is limited to depth 512 and one million visited objects; a limit failure is a
`TargetDiagnostic` with code `BEND-SBF100`. For declarations, the wrapper copies
only `$`, `n` and the lazily read `v` body used by pinned `term_wnf`; unrelated
`T`, `e` and constructor metadata do not consume that budget. Registry lookup
uses ordinary inherited property lookup to match the pinned evaluator.

This is an isolation boundary for the pinned checker-produced term graph, not
a JavaScript sandbox or a preservation theorem. Checker binder closures may
retain the original book. In particular, closures built by
`term_check_mat_goal` call `tele_head` and `term_wnf` internally on that book;
the wrapper cannot intercept those calls. The pinned closure shape and this
internal behavior are explicit assumptions. On the SHA-256 reference and six
application books used by the regression, snapshot probes found no such
original-cell writes during emission. Arbitrary evaluator rewrites and runtime
expression normalization are outside this change.

## Evidence

`tests/type-evaluation.ts` contains a fixed-seed differential over fresh graphs,
checks exact original memo-cell state, and compares query orders. Its raw
`B.term_wnf` control uses seed 2307: the first query changes a memo cell from
`i = -1` to `i = -2`, and the second query differs from its fresh result. The
same case through `isolatedTypeWhnf` is order-independent and leaves every
original cell's `i` and `v` identity unchanged. The file also covers nested
constructor sharing, returned-closure arguments, inherited declarations,
irrelevant deep metadata, coded bounds failures and a static compiler check
that raw `term_wnf`/`term_snf` calls appear only in this wrapper.

`tests/type-evaluation-applications.ts` snapshots memo-cell states by identity
before and after actual emission, including cells exposed by opening checker
binder closures. It compares the exact C output and a hash of the complete
emission for the SHA-256 reference, vault, vesting, exchange, AMM, batch and
queue. `tests/type-evaluation/application-baselines.json` records the checked
source input hashes, pinned Bun 1.4.2, TypeScript 5.2.2 and Bend commit
`7561656155a4285c1e4ccfcb3505ab59524de973`, along with prior output hashes. The
separate `baseline-hashes.json` preserves the host review's exact six candidate
input hashes. The permanent tests do not import a second Backend.

The intentional square-root width optimization changes AMM source and output
hashes. Its historical comparison uses `historical/sqrt.bend`, copied from the
fixture's baseline commit and required to match the original input digest.
All other inputs must still match; substitutions are explicitly allowlisted.
The test stages those exact source bytes without changing old expected output
hashes, and additionally checks identity and memo-cell preservation while
emitting the current AMM. Explicit `TYPE_EVALUATION_SOURCE_ROOT` inputs retain
strict source-pin checking without substitutions.

Run the focused gates from the repository root:

```sh
bun tests/type-evaluation.ts
bun tests/type-evaluation-applications.ts
```

The emission hashes establish finite equality for the recorded source inputs
and pinned tools. They do not show that every term is preserved, prove the
compiler, or cover arbitrary JavaScript closures. The test files are not
registered in package scripts or CI as part of this change.

Nested ownership marking has a bounded traversal cost that can grow with both
argument size and the number of applications. Synthetic deep alias chains can
be much slower than raw evaluation or reach BEND-SBF100 despite raw evaluation
succeeding. The current evidence covers the listed applications, not equivalent
performance or acceptance for every valid type. The static raw-call test checks
textual calls in compiler sources; it is not a complete indirect-call analysis
and does not cover verification/model.ts.
