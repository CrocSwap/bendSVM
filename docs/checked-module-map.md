# Checked module namespaces

`checkedProgram` returns `modules` alongside its existing `book` and `files`.
Each entry also records declaration-name events from the loader completion
boundary. Imported modules finish first; their events are recorded before their
importer parses. A law declaration and its proof in another file retain both
origin events. Constructors inherit their datatype declaration origins.

Each entry contains the loader's recorded `file` path and the exact
resolved `namespace` used in that checked book. Entry order matches `files`.
The metadata is returned only after the ordinary proof gate succeeds.

This records the pinned loader's `seen` map. It is not necessarily the physical
file whose bytes were read: with a symlinked directory followed by a parent
(`..`) import, the loader's `realpathSync` result can differ from the path the
kernel follows for its read. Hashing `modules[].file` alone can therefore hash
the wrong bytes even without a concurrent writer. Source qualification must
independently exclude these ambiguous import paths or establish read-time
provenance before it relies on those hashes. It does not infer namespaces from
local import aliases, basenames or declaration suffixes. Relative namespaces can
change when the entrypoint moves, even if physical dependencies stay the same.
The loader rejects importing one physical file under two different namespaces.
The empty namespace can occur for both the entrypoint and the standard library;
callers must not assume that namespaces alone uniquely identify physical files.

The map is descriptive metadata, not a proof capability, source-byte receipt or
specialization permit. Callers that authorize special lowering must additionally
bind full sources, the checked graph, compiler support and toolchain inputs, and
reuse the same checked book. The upstream loader reads sources internally;
metadata does not eliminate the ordinary trusted-build-filesystem assumption.

Run `bun tests/checked-module-map.ts` for nested imports, alias changes, physical
symlink identity, adjacent-law/open-law refusal, and the actual SHA module map.

## Canonical module and instance names

`checkedModuleNames` accepts that loader map and explicit physical-file/label
bindings. It maps exact namespace prefixes and canonicalizes generic instance
names using the pinned checker's closed argument keys, normalized recursively.
It checks injectivity across both declarations and constructors, rejects missing
or ambiguous bindings, duplicate instance identities, cycles, malformed argument
JSON, and bounded traversal excess. Bindings with overlapping dotted namespaces among any loaded modules reject,
including unbound modules. Other modules retain their exact namespace prefixes;
generic instance numbering is canonicalized throughout the book.

This helper is naming only. The caller supplies labels and the helper does not
hash source files, authenticate those bindings, compare checked bodies, or
produce a specialization permit. In particular, instance metadata alone never
establishes semantic identity. The full checked definition/type/constructor
closure must be compared under the injective mapping. The helper assumes its
book and module map come from the same trusted `checkedProgram` invocation;
arbitrary executable JavaScript objects are not supported inputs.

Run `bun tests/checked-module-names.ts` for relocation plus earlier-import generic
renumbering, namespace boundaries and twelve malformed/collision refusals.

Naming limits are 4,096 instances, one million characters per argument key,
one million visited argument values, 512 argument traversal levels and 128
name-recursion levels. These are recursion/work guards rather than a structural
normal-form bound; cached instances can make refusal depend on visitation order.
The argument limit supports the documented Nat fuel boundary of 64.

Canonical binding additionally checks declaration origins, including root and
Base declarations. This supports same-directory module bindings while refusing
to credit a root dotted name or Base primitive to an imported file. Origin events
are observed through the supplied Map at the pinned loader completion boundary;
this dependency must be re-reviewed if the upstream loader changes. They do not
repair the recorded-file/read-byte issue described above. A combined 512-frame
guard bounds nested name-plus-argument recursion in addition to the individual
limits.
