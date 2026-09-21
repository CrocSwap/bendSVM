# Target diagnostics

The checked Bend frontend runs before target lowering. Its source/type/law errors
retain Bend's diagnostics. The target backend now adds stable categories and hints
for its own rejected runtime forms. When lowering fails inside a function, the
message identifies that function (including specialization identity where known).
Target errors do not yet consistently carry source line/column spans.

| Code | Meaning | Typical correction |
| --- | --- | --- |
| BEND-SBF100 | Unsupported runtime form or target/checking constraint | Use concrete first-order values and fully applied calls; inspect the detailed message |
| BEND-SBF101 | Unsupported recursion or recursive representation | Use bounded storage and structural Nat tail recursion |
| BEND-SBF102 | Invalid Nat construction or fuel bound | Use fuel 0–64; split larger jobs into transactions |
| BEND-SBF103 | Generic specialization constraint | Supply concrete erased type arguments and finite nonrecursive types |
| BEND-SBF104 | More than eight runtime arguments | Group values into a record |
| BEND-SBF201 | Canonical value exceeds 1,024 bytes | Reduce the per-call window/value; use account-backed storage for the complete collection |
| BEND-SBF202 | Native value exceeds 1,536 bytes | Reduce the per-call window or record size |
| BEND-SBF203 | Clang rejects an oversized SBF stack frame | Reduce live temporaries or window size; inspect the preserved compiler diagnostic |
| BEND-SBF300 | Collection ABI structural mismatch | Match the selection/transition signatures and element layout in collection-storage.md |

For example, a runtime function argument of type `U32 -> U32` is rejected with
BEND-SBF100, the failing function name, the original runtime-type detail and a
hint. A large record reports its measured canonical byte size with BEND-SBF201.
Existing detailed messages remain available to callers. TargetDiagnostic exposes
`code`, `detail`, `hint`, optional `functionName`, and `toJSON()` to tooling.
The CLI prints the human-readable form and exits nonzero; it does not yet provide
a JSON-output flag or editor integration.

Builds emit `.resources.json` with every canonical and native value size, and
`.stack.json` with Clang's per-function stack usage and largest frame. The public
build prints the largest sizes against their limits and hashes both reports in
its manifest. Native sizes follow the backend's exact u32-aligned representation;
tests compare the report with C `sizeof`. Dedicated oversized-value and stack
fixtures verify the new failure categories. Generated C retains its static assert
as a second check. Stack report locations are independent of the output directory
so fresh builds can reproduce the manifest.

These categories do not cover every possible toolchain failure. Linker failures
and some other ABI/schema validators still use their existing diagnostics.
Successful compilation and stack reports do not prove worst-case compute usage.

The collection client separately rejects invalid descriptor/metadata/window
inputs. On-chain adapter errors remain numeric and application rejections retain
the storage error mapping; see collection-storage.md. Compiler diagnostics do not
replace runtime authorization, account validation or application invariants.
