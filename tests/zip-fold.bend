import Base
import ../sdk/buffer.bend as B
import ../sdk/zip-fold.bend as Z

# Noncommutative ordered witness for all 32 paired leaves.
def step(acc: U32, q: U32, w: U32) -> U32:
  U32.add(U32.mul(acc, 131), U32.add(U32.mul(q, 7), w))

def order(q: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>>,
    w: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>>, initial: U32) -> U32:
  Z.fold32(U32, U32, step, q, w, initial)
