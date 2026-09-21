import Base

# A compiler/proof plumbing probe, not a balance-conservation specification.
# U32 addition is modular; commutativity does not establish absence of overflow.
def add(a: U32, b: U32) -> U32:
  U32.add(a, b)

law add_commutes:
  for a: U32
  for b: U32
  {add(a, b) == add(b, a) : U32}

def add_commutes(a, b):
  U32.add_comm(a, b)

def main() -> U32:
  add(20, 22)
