# Local source path qualification candidate

`validateCheckedSourcePaths` is a separate, unconnected precondition for a local
source specialization profile. It does not change ordinary `checkedProgram`.
It reconstructs paths from the entry directory and complete loader namespace map,
checks components before parent traversal, rejects symlinks on the rebuilt paths, and requires the
result to equal the loader's recorded file. Empty namespaces are restricted to
the entry and pinned Base. Hub-cache imports require a separate profile and
currently refuse here; ordinary compiler package support is unchanged.

The test reproduces the pinned loader's symlink-directory plus `..` mismatch:
the recorded file contains `near`, while the loaded book contains `far` from a
different directory. The guard refuses that graph. Normal nested parent imports
and the actual SHA fixture pass; file symlink aliases, missing entry metadata and
duplicate file records refuse.

This assumes an unchanged, non-hostile filesystem from checking through artifact
production. It is not a read-time byte receipt and cannot defend against a writer
changing paths between filesystem operations. The caller still needs the actual
complete loader map from the same check, full source and compiler/toolchain pins,
checked graph comparison and emission binding. Independent review accepted this precondition under the stated pinned-loader,
Bun 1.4.2 and macOS/APFS scope.

Run `bun tests/checked-source-paths.ts`.

Namespaces ending in `/` are refused. A file named `.bend` produces such a
namespace, and the pinned loader resolves that module's children from a physical
parent different from the namespace parent. The permanent dotfile/symlink test
reproduces a checked `U32.add(x, 7)` body while the recorded file contains `x`.
This profile rejects that input before source hashes can authorize substitution.
The ordinary loader still supports these filenames; this is a qualification
restriction only. This correction was independently reviewed with alternate path spellings and
an old-guard negative control.
