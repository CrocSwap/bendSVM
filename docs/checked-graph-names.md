# Normalized checked graph candidate

The private identity prototype accepts an optional canonical-name callback. The
default remains exact names. Dependency lookup and template-placeholder checks
use raw checked names; hashing maps global Ref/ADT/Ctr/Mat names, ADT reference
lists, declaration keys, constructor/registry names, roots and allowed unresolved
placeholders. Local binder spellings are not renamed.

The intended callback is `checkedModuleNames(...).canonical`, with bindings from
the same checked program. Names must be injective over declarations, constructors
and all observed names. The caller must choose and bind the module labels and
source identities; an arbitrary callback is not evidence of equivalent programs.
The complete checked graph is hashed after naming, not just the generic-instance
metadata. Neither helper returns permission to substitute compiled code.

`tests/checked-graph-names.ts` checks the complete 160-definition SHA closure
across relocated imports and an earlier unrelated Bool generic instance. It also
checks three independently restored source mutations: a round constant, a
transitive generic helper and constructor field order. A restored-source positive
control must return the original identity; collapsing all names must refuse.

This candidate inherits the identity helper's trusted parametric checker closure
assumption, traversal bounds and metadata validation. Backend memo isolation,
source/toolchain binding, exact emission binding, the proof gate, final-ELF
checks and differential runtime evidence remain separate obligations. Independent review accepted the naming scope; staged tests also combine it
with isolated Backend type evaluation. No preservation theorem or SHA specialization authorization is claimed.

The helper snapshots the callback's first answer for each raw name, so repeated
references and roots cannot drift between canonical names within one operation.
The renumbering test requires raw numeric instance suffixes to actually differ.

Graph equality does not establish identical lowering. For example,
`native-arithmetic.ts` selects native math paths using raw `/sdk/math.*` names
and a hash of source-span text. Normalization erases those raw names and identity
omits spans, so equal normalized graphs can select different C lowerings. Math
is outside this tested SHA closure. A future authorization mechanism must bind
and validate the actual lowering configuration and emitted artifact separately.
