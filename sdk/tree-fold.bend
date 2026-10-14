import Base
import ./buffer.bend as B
import ./fold.bend as F
import ./iteration.bend as I

# Fallible left folds over fixed Pair trees with a runtime active prefix.
# fold4/fold32 require exact Nat fuel and length within the concrete capacity.
# Full subtrees omit dynamic indexing; empty subtrees preserve the accumulator.
# Reducer failure is absorbing. Internal tree helpers assume a valid prefix.
# The capacity bounds each vector, not an application's total element count.

def increment(n: U32) -> U32: U32.add(n, 1)
def fuel_value(fuel: Nat) -> U32: I.repeat(U32, increment, fuel, 0)
def left_length(length: U32, half: U32) -> U32: U32.min(length, half)
def right_gate(has_right: Bool, length: U32, half: U32) -> U32:
  match has_right:
    case False{}: 0
    case True{}: U32.sub(length, half)
def right_length(+length: U32, +half: U32) -> U32: right_gate(U32.is_gt(length, half), length, half)
def tree1(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, active: Bool, accumulator: B.Result<A>, value: T) -> B.Result<A>:
  match active:
    case False{}: accumulator
    case True{}: F.combine(T, A, reduce, accumulator, B.Valid{value})
def full2(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, accumulator: B.Result<A>, storage: B.Pair<T>) -> B.Result<A>:
  match storage:
    case B.Pair{left, right}:
      first = F.combine(T, A, reduce, accumulator, B.Valid{left})
      F.combine(T, A, reduce, first, B.Valid{right})
def partial2(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, +length: U32, accumulator: B.Result<A>, storage: B.Pair<T>) -> B.Result<A>:
  match storage:
    case B.Pair{left, right}:
      first = tree1(T, A, reduce, U32.is_gt(left_length(length, 1), 0), accumulator, left)
      tree1(T, A, reduce, U32.is_gt(right_length(length, 1), 0), first, right)
def gate2(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, active: Bool, full: Bool, length: U32, accumulator: B.Result<A>, storage: B.Pair<T>) -> B.Result<A>:
  match active full:
    case False{} _: accumulator
    case True{} True{}: full2(T, A, reduce, accumulator, storage)
    case True{} False{}: partial2(T, A, reduce, length, accumulator, storage)
def tree2(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, +length: U32, accumulator: B.Result<A>, storage: B.Pair<T>) -> B.Result<A>:
  gate2(T, A, reduce, U32.is_gt(length, 0), U32.is_eq(length, 2), length, accumulator, storage)
def full4(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, accumulator: B.Result<A>, storage: B.Pair<B.Pair<T>>) -> B.Result<A>:
  match storage:
    case B.Pair{left, right}:
      first = full2(T, A, reduce, accumulator, left)
      full2(T, A, reduce, first, right)
def partial4(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, +length: U32, accumulator: B.Result<A>, storage: B.Pair<B.Pair<T>>) -> B.Result<A>:
  match storage:
    case B.Pair{left, right}:
      first = tree2(T, A, reduce, left_length(length, 2), accumulator, left)
      tree2(T, A, reduce, right_length(length, 2), first, right)
def gate4(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, active: Bool, full: Bool, length: U32, accumulator: B.Result<A>, storage: B.Pair<B.Pair<T>>) -> B.Result<A>:
  match active full:
    case False{} _: accumulator
    case True{} True{}: full4(T, A, reduce, accumulator, storage)
    case True{} False{}: partial4(T, A, reduce, length, accumulator, storage)
def tree4(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, +length: U32, accumulator: B.Result<A>, storage: B.Pair<B.Pair<T>>) -> B.Result<A>:
  gate4(T, A, reduce, U32.is_gt(length, 0), U32.is_eq(length, 4), length, accumulator, storage)
def full8(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, accumulator: B.Result<A>, storage: B.Pair<B.Pair<B.Pair<T>>>) -> B.Result<A>:
  match storage:
    case B.Pair{left, right}:
      first = full4(T, A, reduce, accumulator, left)
      full4(T, A, reduce, first, right)
def partial8(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, +length: U32, accumulator: B.Result<A>, storage: B.Pair<B.Pair<B.Pair<T>>>) -> B.Result<A>:
  match storage:
    case B.Pair{left, right}:
      first = tree4(T, A, reduce, left_length(length, 4), accumulator, left)
      tree4(T, A, reduce, right_length(length, 4), first, right)
def gate8(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, active: Bool, full: Bool, length: U32, accumulator: B.Result<A>, storage: B.Pair<B.Pair<B.Pair<T>>>) -> B.Result<A>:
  match active full:
    case False{} _: accumulator
    case True{} True{}: full8(T, A, reduce, accumulator, storage)
    case True{} False{}: partial8(T, A, reduce, length, accumulator, storage)
def tree8(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, +length: U32, accumulator: B.Result<A>, storage: B.Pair<B.Pair<B.Pair<T>>>) -> B.Result<A>:
  gate8(T, A, reduce, U32.is_gt(length, 0), U32.is_eq(length, 8), length, accumulator, storage)
def full16(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, accumulator: B.Result<A>, storage: B.Pair<B.Pair<B.Pair<B.Pair<T>>>>) -> B.Result<A>:
  match storage:
    case B.Pair{left, right}:
      first = full8(T, A, reduce, accumulator, left)
      full8(T, A, reduce, first, right)
def partial16(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, +length: U32, accumulator: B.Result<A>, storage: B.Pair<B.Pair<B.Pair<B.Pair<T>>>>) -> B.Result<A>:
  match storage:
    case B.Pair{left, right}:
      first = tree8(T, A, reduce, left_length(length, 8), accumulator, left)
      tree8(T, A, reduce, right_length(length, 8), first, right)
def gate16(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, active: Bool, full: Bool, length: U32, accumulator: B.Result<A>, storage: B.Pair<B.Pair<B.Pair<B.Pair<T>>>>) -> B.Result<A>:
  match active full:
    case False{} _: accumulator
    case True{} True{}: full16(T, A, reduce, accumulator, storage)
    case True{} False{}: partial16(T, A, reduce, length, accumulator, storage)
def tree16(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, +length: U32, accumulator: B.Result<A>, storage: B.Pair<B.Pair<B.Pair<B.Pair<T>>>>) -> B.Result<A>:
  gate16(T, A, reduce, U32.is_gt(length, 0), U32.is_eq(length, 16), length, accumulator, storage)
def full32(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, accumulator: B.Result<A>, storage: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<T>>>>>) -> B.Result<A>:
  match storage:
    case B.Pair{left, right}:
      first = full16(T, A, reduce, accumulator, left)
      full16(T, A, reduce, first, right)
def partial32(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, +length: U32, accumulator: B.Result<A>, storage: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<T>>>>>) -> B.Result<A>:
  match storage:
    case B.Pair{left, right}:
      first = tree16(T, A, reduce, left_length(length, 16), accumulator, left)
      tree16(T, A, reduce, right_length(length, 16), first, right)
def gate32(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, active: Bool, full: Bool, length: U32, accumulator: B.Result<A>, storage: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<T>>>>>) -> B.Result<A>:
  match active full:
    case False{} _: accumulator
    case True{} True{}: full32(T, A, reduce, accumulator, storage)
    case True{} False{}: partial32(T, A, reduce, length, accumulator, storage)
def tree32(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, +length: U32, accumulator: B.Result<A>, storage: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<T>>>>>) -> B.Result<A>:
  gate32(T, A, reduce, U32.is_gt(length, 0), U32.is_eq(length, 32), length, accumulator, storage)
def checked4(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, valid: Bool, vector: B.Vector<T, B.Pair<B.Pair<T>>>, initial: A) -> B.Result<A>:
  match valid vector:
    case False{} _: B.Invalid{}
    case True{} B.Vector{length, storage}: tree4(T, A, reduce, length, B.Valid{initial}, storage)
def fold4(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, fuel: Nat, +vector: B.Vector<T, B.Pair<B.Pair<T>>>, initial: A) -> B.Result<A>:
  match vector:
    case B.Vector{+length, _}:
      checked4(T, A, reduce, Bool.and(U32.is_le(length, 4), U32.is_eq(fuel_value(fuel), length)), vector, initial)
def checked32(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, valid: Bool, vector: B.Vector<T, B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<T>>>>>>, initial: A) -> B.Result<A>:
  match valid vector:
    case False{} _: B.Invalid{}
    case True{} B.Vector{length, storage}: tree32(T, A, reduce, length, B.Valid{initial}, storage)
def fold32(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>, fuel: Nat, +vector: B.Vector<T, B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<T>>>>>>, initial: A) -> B.Result<A>:
  match vector:
    case B.Vector{+length, _}:
      checked32(T, A, reduce, Bool.and(U32.is_le(length, 32), U32.is_eq(fuel_value(fuel), length)), vector, initial)
