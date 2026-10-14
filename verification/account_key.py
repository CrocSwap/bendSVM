"""Bitvector bridge for the reviewed 32-byte account-key comparison."""

import hashlib
import json
import pathlib

import z3


ROOT = pathlib.Path(__file__).resolve().parent.parent
HEADER = ROOT / "runtime/solana_min.h"
SOURCE = HEADER.read_text()
EXPECTED = """static inline unsigned equal_key(const u8 *a, const u8 *b) {
  /* Account keys are public. Copy into scalars so unaligned pointers and
   * strict aliasing are safe; stop at the first differing eight-byte chunk. */
  for (unsigned i = 0; i < 32; i += 8) {
    u64 left, right;
    __builtin_memcpy(&left, a + i, 8);
    __builtin_memcpy(&right, b + i, 8);
    if (left != right) return 0;
  }
  return 1;
}"""
def reviewed(source: str) -> bool:
    return source.count(EXPECTED) == 1


if not reviewed(SOURCE):
    raise SystemExit("Reviewed equal_key C body changed; update and recheck its proof model")
MUTATED_SOURCE = SOURCE.replace(EXPECTED, EXPECTED.replace("i < 32", "i < 24"))
if reviewed(MUTATED_SOURCE):
    raise SystemExit("Shortened C loop escaped the exact-body audit")
if z3.get_version_string() != "5.1.0":
    raise SystemExit("Expected Z3 5.1.0")


def check(endian: str, chunks: int):
    a = [z3.BitVec(f"a_{i}", 8) for i in range(32)]
    b = [z3.BitVec(f"b_{i}", 8) for i in range(32)]

    def word(items):
        return z3.Concat(*(items[::-1] if endian == "little" else items))

    byte_equal = z3.And(*(a[i] == b[i] for i in range(32)))
    word_equal = z3.And(*(word(a[8 * i:8 * i + 8]) == word(b[8 * i:8 * i + 8])
                          for i in range(chunks)))
    solver = z3.Solver()
    solver.set(timeout=30000)
    solver.add(word_equal != byte_equal)
    result = solver.check()
    if result == z3.unknown:
        raise SystemExit(f"Z3 returned unknown: {solver.reason_unknown()}")
    witness = None
    if result == z3.sat:
        model = solver.model()
        left = [model.eval(x, model_completion=True).as_long() for x in a]
        right = [model.eval(x, model_completion=True).as_long() for x in b]
        witness = {"left": bytes(left).hex(), "right": bytes(right).hex(),
                   "differing_bytes": [i for i in range(32) if left[i] != right[i]]}
    return str(result), witness


claims = []
for endian in ("little", "big"):
    result, _ = check(endian, 4)
    if result != "unsat":
        raise SystemExit(f"Four-chunk {endian} comparison failed: {result}")
    claims.append({"endianness": endian, "chunks": 4, "result": result})
    result, witness = check(endian, 3)
    if result != "sat" or not witness or not all(i >= 24 for i in witness["differing_bytes"]):
        raise SystemExit(f"Shortened {endian} comparison did not yield the expected counterexample")
    claims.append({"endianness": endian, "chunks": 3, "result": result,
                   "counterexample": witness})

report = {"scope": "equal_key compares all 32 key bytes by four 8-byte chunks",
          "assumptions": ["pointers address 32 readable bytes", "u64 is 64 bits",
                          "memcpy copies the exact eight bytes into each scalar"],
          "z3": z3.get_version_string(),
          "source_mutation": "shortened C loop rejected by exact-body audit",
          "inputs": {str(HEADER.relative_to(ROOT)): hashlib.sha256(HEADER.read_bytes()).hexdigest(),
                     "verification/account_key.py": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()},
          "claims": claims}
output = ROOT / "build/account-key-refinement.json"
output.parent.mkdir(exist_ok=True)
output.write_text(json.dumps(report, indent=2) + "\n")
print(f"Account-key comparison: two UNSAT proofs and two SAT shortened-loop mutations; {output.relative_to(ROOT)}")
