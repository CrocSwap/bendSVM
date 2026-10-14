import ../../sdk/sha256-packed.bend as SHA
import ../../sdk/sha256-reference.bend as S

def hash_packed(message: SHA.Message) -> S.HashResult:
  SHA.hash_bounded(message)
