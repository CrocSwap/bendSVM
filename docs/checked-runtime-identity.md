# Checked runtime identity

`compiler/checked-runtime-identity.ts` fingerprints exact resolved checked
declarations reachable from supplied roots. It includes checked runtime bodies,
original declaration bodies used by type reduction,
declaration types, datatype constructor order and types, primitive status, and
generic metadata. Higher-order `Var.v` memo values are lowered with a bounded implementation of
the pinned checker operations before serialization. Term kinds and fields are
validated before lowering, including values returned by binder closures. A plain JSON encoding would omit
their JavaScript closures.

Open memo values, original declaration bodies, declaration types and constructor
telescopes bind an ordered pair of lowerings at binder depths zero and
one. A free context index remains fixed across the pair; a locally bound index
shifts by one. This avoids conflating free and bound variables at depth zero.

The versioned digest binds ordered, distinct function roots and sorted per-declaration hashes.
Names are exact by default. An optional injective canonical-name callback is
described in [checked-graph-names.md](checked-graph-names.md); naming alone
does not establish equivalent lowering. Source spans
are omitted. Unsupported executable values, unresolved dependencies, object
cycles, unsafe/foreign definitions, holes, and resource-limit violations reject.
Both checked runtime bodies (`e`) and original bodies (`v`) contribute. The only
unresolved reference allowed is a template's own erased binder, spelled
`<template>~<binder>`, in that template's checked `e` when the template is
reachable only through original bodies. Original bodies, declaration types,
and runtime-reachable checked bodies have no missing-name exemption. The exact
allowed absences are bound in the digest. If traversal later reaches a template
through a checked path, its checked references are audited again without the
exemption.

The bounded lowerer rejects unsupported substitution/pattern terms, malformed
memo values, cycles and depth/work excess. It shares lowered subterms by object
and binder depth. Structural node hashes preserve DAG sharing during identity
encoding, avoiding exponential serialization of repeated subterms. Checker
closures are assumed parametric and terminating; arbitrary JavaScript closures
are not supported. The recursion guard permits 512 active traversal levels; cached subterms can
make acceptance depend on traversal order, so this is not a structural tree-depth
bound. Other limits are one million lowering
nodes, one million encoding nodes and 4,096 declarations.

This module is not yet connected to compiler specialization. Its return value
is not an authorization capability. Callers must use `checkedProgram`, preserve
the ordinary proof gate, bind the pinned checker and compiler/runtime inputs,
and reuse the same book object without changes between fingerprinting and
lowering. Root selection remains a caller obligation: this utility checks
non-template checked definitions, but does not distinguish a proof definition
from a runtime export. Full source bytes (including laws and proofs), Bun, the
pinned checker, and compiler inputs including `primitives.ts`,
`native-arithmetic.ts`, `backend.ts`, and `tagged-sum-ir.ts` must be bound
separately. The naming callback and its module/source bindings must be qualified separately
before specialization can support equivalent imports with different resolved
names or template instance numbering. Checked `e` objects are fully encoded
but are not independently checked against the runtime term grammar; Backend
must still validate them. Extra declaration metadata is outside the selected
identity fields, and absent and null checked bodies are equivalent here. This
module does not establish read-time file provenance, a preservation theorem,
cryptographic correctness, or safe source-to-syscall substitution. Unreachable
declarations and proof bodies are outside this runtime digest, but remain
subject to the ordinary proof gate.

Run `npm exec -- bun tests/checked-runtime-identity.ts` for fresh checked-source
copy and mutation probes, memo sensitivity, and malformed-graph refusals. The
test leaves a report and its small source fixture under `build/`. Independent
review is required before this mechanism can authorize special lowering.

Declaration and constructor records are checked for plain data descriptors before
fields are read. Constructor arrays must be dense plain arrays without extra
properties. Validation includes unreachable registry entries, although their
semantic contents remain outside the digest. Arbitrary JavaScript proxies and
non-parametric checker closures remain outside the supported input.

Constructor names and declaration/constructor arities are validated as primitive
strings and nonnegative safe integers before lookup or iteration. Malformed
object-valued scalar fields reject without invoking their coercion hooks.
