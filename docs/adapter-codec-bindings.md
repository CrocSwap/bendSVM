# Adapter codec dependency binding checks

Run the focused emitted-header check with:

```sh
bun tests/adapter-codec-bindings.ts
```

The harness checks generic pure Bend fixtures, emits their schema, interface,
native header, wire header and adapter through the normal checked-source and
artifact-writer path, then archives and hashes the artifacts. Python reads those
archived files and runs the real ABI 1 and ABI 2 schema summarizers and
`audit_dependencies` functions. It covers the 255/256 wire-size boundary for
ABI 1 state and instruction decoders, ABI 2 instruction decoders and ABI 2
state-field decoders. ABI 1 uniqueness checks cover the context, key and slot
makers, the root, and its state/instruction codec functions. ABI 1 has no
synthesized `state_maker` binding in its adapter summary. Positive controls
include harmless whitespace and comments containing binding-like text. The
27 negative controls preserve the original 20 cases and add conflicting
prototypes before codec, maker and root definitions, where Clang can merge
prototype attributes into the definition. Annotation changes, unsupported and
reordered attributes, macro rewriting, and duplicate or conflicting
file-scope bindings remain covered.

The check requires the pinned Bend dependency, Bun, Python 3 and the Z3 Python
binding reporting version 5.1.0. It writes a unique evidence directory below
`build/adapter-codec-bindings-*` and fails on missing Python, process-start
errors, a nonzero Python exit, unexpected acceptance or the wrong diagnostic.

This focused dependency audit does not inspect codec bodies or establish codec
correctness. It does not compile C, validate LLVM or SBF, measure stack use or
call depth, or replace the full ABI 1/ABI 2 adapter contract gates.
