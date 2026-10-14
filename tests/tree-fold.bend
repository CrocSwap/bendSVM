import Base
import ../sdk/buffer.bend as B
import ../sdk/fold.bend as F
import ../sdk/tree-fold.bend as T
import ../sdk/math.bend as M

def order_gate(failed: Bool, value: U32) -> B.Result<U32>:
  match failed:
    case True{}: B.Invalid{}
    case False{}: B.Valid{value}
def order_step(accumulator: U32, value: U32) -> B.Result<U32>:
  +word = value
  order_gate(U32.is_eq(word, 4294967295), U32.add(U32.mul(accumulator, 131), word))
def read4(storage: B.Pair<B.Pair<U32>>, index: U32) -> U32:
  B.quad_get(U32, storage, index)
def read8(storage: B.Pair<B.Pair<B.Pair<U32>>>, index: U32) -> U32:
  +offset = index
  read4(B.pair_get(B.Pair<B.Pair<U32>>, storage, U32.div(offset, 4)), U32.and(offset, 3))
def read16(storage: B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>, index: U32) -> U32:
  +offset = index
  read8(B.pair_get(B.Pair<B.Pair<B.Pair<U32>>>, storage, U32.div(offset, 8)), U32.and(offset, 7))
def read32(storage: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>>, index: U32) -> U32:
  +offset = index
  read16(B.pair_get(B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>, storage, U32.div(offset, 16)), U32.and(offset, 15))
def order4(fuel: Nat, vector: B.Vector<U32, B.Pair<B.Pair<U32>>>, initial: U32) -> B.Result<U32>:
  T.fold4(U32, U32, order_step, fuel, vector, initial)
def indexed4(fuel: Nat, vector: B.Vector<U32, B.Pair<B.Pair<U32>>>, initial: U32) -> B.Result<U32>:
  F.fold(U32, B.Pair<B.Pair<U32>>, U32, 4, read4, order_step, fuel, vector, initial)
def order32(fuel: Nat, vector: B.Vector<U32, B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>>>, initial: U32) -> B.Result<U32>:
  T.fold32(U32, U32, order_step, fuel, vector, initial)
def indexed32(fuel: Nat, vector: B.Vector<U32, B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>>>, initial: U32) -> B.Result<U32>:
  F.fold(U32, B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>>, U32, 32, read32, order_step, fuel, vector, initial)

type Accumulator is Data:
  Accumulator{digest: U32, count: U32, sum: M.U64}
def wide_gate(failed: Bool, value: Accumulator) -> B.Result<Accumulator>:
  match failed:
    case True{}: B.Invalid{}
    case False{}: B.Valid{value}
def wide_step(accumulator: Accumulator, value: M.U64) -> B.Result<Accumulator>:
  match accumulator value:
    case Accumulator{digest, count, sum} M.U64{+lo, +hi}:
      wide_gate(M.equal(M.U64{lo, hi}, M.U64{4294967295, 4294967295}),
        Accumulator{U32.add(U32.mul(digest, 131), U32.add(lo, U32.mul(hi, 17))),
          U32.add(count, 1), M.add_wrap(sum, M.U64{lo, hi})})
def wide_read8(storage: B.Pair<B.Pair<B.Pair<M.U64>>>, index: U32) -> M.U64:
  +offset = index
  B.quad_get(M.U64, B.pair_get(B.Pair<B.Pair<M.U64>>, storage, U32.div(offset, 4)), U32.and(offset, 3))
def wide_read16(storage: B.Pair<B.Pair<B.Pair<B.Pair<M.U64>>>>, index: U32) -> M.U64:
  +offset = index
  wide_read8(B.pair_get(B.Pair<B.Pair<B.Pair<M.U64>>>, storage, U32.div(offset, 8)), U32.and(offset, 7))
def wide_read32(storage: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<M.U64>>>>>, index: U32) -> M.U64:
  +offset = index
  wide_read16(B.pair_get(B.Pair<B.Pair<B.Pair<B.Pair<M.U64>>>>, storage, U32.div(offset, 16)), U32.and(offset, 15))
def compound32(fuel: Nat, vector: B.Vector<M.U64, B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<M.U64>>>>>>, initial: Accumulator) -> B.Result<Accumulator>:
  T.fold32(M.U64, Accumulator, wide_step, fuel, vector, initial)
def indexed_compound32(fuel: Nat, vector: B.Vector<M.U64, B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<M.U64>>>>>>, initial: Accumulator) -> B.Result<Accumulator>:
  F.fold(M.U64, B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<M.U64>>>>>, Accumulator, 32, wide_read32, wide_step, fuel, vector, initial)
