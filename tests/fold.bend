import Base
import ../sdk/buffer.bend as B
import ../sdk/fold.bend as F

def read_word(storage: B.Pair<B.Pair<U32>>, index: U32) -> U32:
  B.quad_get(U32, storage, index)

def read_flag(storage: B.Pair<Bool>, index: U32) -> Bool:
  B.pair_get(Bool, storage, index)

def sum_checked(overflow: Bool, sum: U32) -> B.Result<U32>:
  match overflow:
    case True{}:
      B.Invalid{}
    case False{}:
      B.Valid{sum}

def add(accumulator: U32, value: U32) -> B.Result<U32>:
  +start = accumulator
  +sum = U32.add(start, value)
  sum_checked(U32.is_lt(sum, start), sum)

def order(accumulator: U32, value: U32) -> B.Result<U32>:
  B.Valid{U32.add(U32.mul(accumulator, 31), value)}

def all(accumulator: Bool, value: Bool) -> B.Result<Bool>:
  B.Valid{Bool.and(accumulator, value)}

def sum(fuel: Nat, vector: B.Vector<U32, B.Pair<B.Pair<U32>>>, initial: U32) -> B.Result<U32>:
  F.fold(U32, B.Pair<B.Pair<U32>>, U32, 4, read_word, add, fuel, vector, initial)

def ordered(fuel: Nat, vector: B.Vector<U32, B.Pair<B.Pair<U32>>>, initial: U32) -> B.Result<U32>:
  F.fold(U32, B.Pair<B.Pair<U32>>, U32, 4, read_word, order, fuel, vector, initial)

def conjunction(fuel: Nat, vector: B.Vector<Bool, B.Pair<Bool>>, initial: Bool) -> B.Result<Bool>:
  F.fold(Bool, B.Pair<Bool>, Bool, 2, read_flag, all, fuel, vector, initial)
