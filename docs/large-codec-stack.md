# Large canonical codec stack use

Generated ADT decoders with wire values of at least 256 bytes are marked
`noinline`, keeping them out of their caller's frame in the target build. Small
codec declarations and canonical bytes remain unchanged. Decoders still check
exact length, tags and zero padding. ADT decoders build fields into locals and
assign the caller's output only after the whole ADT succeeds. Primitive
bounded-u32 decoders have a narrower contract: they may write the decoded value
before rejecting it against the primitive's maximum.

There is no schema nesting limit in the codec generator. `noinline` on a large
ADT does not establish a maximum call depth: Clang may outline other helpers,
and the resulting call chain depends on generated code and compiler decisions.
The feature does not claim a proved call-depth bound. The build checks each
generated function's frame against the 4,096-byte SBF frame limit and emits a
stack report; that per-frame check does not establish a total call-depth bound.

The permanent generic fixture is `tests/large-codec.ts`. It checks native
round-trip and malformed-input rejection under ASan/UBSan, output preservation
for failed ADT decodes and dispatcher calls, exact 255/256-byte outlining
behavior, a round-trip through nine nested small ADTs, and SBF frame reports.
Its generated files stay under `build/large-codec/`, which is cleared before each
run. The SBF fixture includes the owning `runtime/solana_min.h` by a path
relative to that private directory; it does not copy the header into `build/`.
It can be run with `npm exec -- bun tests/large-codec.ts` using the documented
host Clang and Anza platform-tools v1.53.

Fresh schema and codec generation accepted batch (observed type path depth 11),
queue (10), effect-buffer (9), SHA-reference (9) and rmsnorm (9); those depths
count the primitive leaf and do not represent machine call counts. These are
examples of accepted current schemas, not a configured nesting maximum or a
call-depth guarantee. The original typed codec and nested structure fixtures
also built their SBF modules and passed their native checks.

The current staged DCG tag172 facts/plan identity dispatcher compiled from a
private source copy of current compiler/runtime/SDK dependencies, with the
staged `common.bend` and `tag172.bend` copied into it. The inputs had SHA-256
`907d6078fc2815115f28978859b19b358c137a87f363cb9907be8865dc2e2d65` and
`0d7d8ad04dc32a5299b5099509a85c2613b5c44e63150d740de1f9dbc9f5780d`.
The facts and plan wire values were 954 and 340 bytes; the combined dispatcher
stack report covered 32 functions and a 2,304-byte maximum frame under Clang
20.1.7. This is compilation evidence for those copied inputs only; it does not
establish a general call-depth bound.

The SBF evidence is compilation and per-function frame reporting only. The
fixture and identity projection are not executed in LiteSVM, and these checks
are not a preservation theorem for every generated program.
