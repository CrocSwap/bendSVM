"""Universal bitvector claims for the reviewed generated primitive C codecs."""

import hashlib
import json
import pathlib

import z3


if z3.get_version_string() != "5.1.0":
    raise SystemExit("Expected Z3 5.1.0")
root = pathlib.Path(__file__).resolve().parent.parent
header = root / "build/codec-primitives.wire.h"
if not header.exists():
    raise SystemExit("Generate the reviewed primitive C codec first")


def prove(name, disagreement, expected):
    solver = z3.Solver()
    solver.set(timeout=30000)
    solver.add(disagreement)
    result = solver.check()
    if result == z3.unknown:
        raise SystemExit(f"{name}: Z3 unknown ({solver.reason_unknown()})")
    if str(result) != expected:
        raise SystemExit(f"{name}: expected {expected}, got {result}")
    claim = {"name": name, "result": str(result)}
    if result == z3.sat:
        claim["counterexample"] = {str(v): str(solver.model().eval(v, model_completion=True))
                                    for v in vars_}
    return claim


word = z3.BitVec("word", 32)
bytes_ = [z3.BitVec(f"byte{i}", 8) for i in range(4)]
vars_ = [word, *bytes_]
packed = z3.Concat(*bytes_[::-1])
encoded = [z3.Extract(8 * i + 7, 8 * i, word) for i in range(4)]
# The C decoder's four shifts must agree with the schema's little-endian word.
decoded = (z3.ZeroExt(24, bytes_[0]) |
           (z3.ZeroExt(24, bytes_[1]) << 8) |
           (z3.ZeroExt(24, bytes_[2]) << 16) |
           (z3.ZeroExt(24, bytes_[3]) << 24))
decoded_encoded = (z3.ZeroExt(24, encoded[0]) |
                   (z3.ZeroExt(24, encoded[1]) << 8) |
                   (z3.ZeroExt(24, encoded[2]) << 16) |
                   (z3.ZeroExt(24, encoded[3]) << 24))
claims = [
    prove("u32 decode of encoded value", decoded_encoded != word, "unsat"),
    prove("u32 encoding of decoded bytes", z3.Or(*[z3.Extract(8*i+7, 8*i, decoded) != bytes_[i]
                                                    for i in range(4)]), "unsat"),
]
claims.append(prove("u32 decode expression is little-endian", decoded != packed, "unsat"))
wrong = (z3.ZeroExt(24, bytes_[0]) |
         (z3.ZeroExt(24, bytes_[1]) << 8) |
         (z3.ZeroExt(24, bytes_[2]) << 16) |
         (z3.ZeroExt(24, bytes_[2]) << 24))
claims.append(prove("wrong high byte is detected", wrong != packed, "sat"))

byte = z3.BitVec("bool_byte", 8)
vars_ = [byte]
claims.append(prove("bool accepted bytes are exactly zero or one",
                    (z3.UGT(byte, z3.BitVecVal(1,8))) !=
                    z3.And(byte != 0, byte != 1), "unsat"))
claims.append(prove("missing bool bound is detected", byte == 2, "sat"))

vars_ = [word]
claims.append(prove("Nat accepted words are exactly 0 through 64",
                    (z3.UGT(word, z3.BitVecVal(64,32))) !=
                    z3.Not(z3.ULE(word, z3.BitVecVal(64,32))), "unsat"))
claims.append(prove("missing Nat bound is detected", word == 65, "sat"))

report = {"scope": "generated U32, Bool and bounded Nat canonical C codec templates",
          "assumptions": ["generated C text equals the reviewed template",
                          "pointers designate the guarded 4- or 1-byte regions",
                          "bend_u32 is unsigned 32-bit", "C shifts and casts have unsigned semantics"],
          "z3": z3.get_version_string(),
          "inputs": {"build/codec-primitives.wire.h": hashlib.sha256(header.read_bytes()).hexdigest(),
                     "verification/codec_primitives.py": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()},
          "claims": claims}
output = root / "build/codec-primitives-refinement.json"
output.write_text(json.dumps(report, indent=2) + "\n")
print(f"Primitive C codecs: {sum(x['result']=='unsat' for x in claims)} UNSAT claims, "
      f"{sum(x['result']=='sat' for x in claims)} SAT mutations; {output.relative_to(root)}")
