import Base
import ./buffer.bend as B
import ./iteration.bend as I

# Fallible left fold. State retains the original vector and advances one index
# per iteration. A failed read or reducer stays failed for the rest of the fold.
type Cursor<-T: Data, -S: Data, -A: Data> is Data:
  Cursor{vector: B.Vector<T, S>, index: U32, accumulator: B.Result<A>}

def combine_element(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>,
    accumulator: A, element: B.Result<T>) -> B.Result<A>:
  match element:
    case B.Invalid{}:
      B.Invalid{}
    case B.Valid{value}:
      reduce(accumulator, value)

def combine(~T: Data, ~A: Data, ~reduce: A -> T -> B.Result<A>,
    accumulator: B.Result<A>, element: B.Result<T>) -> B.Result<A>:
  match accumulator:
    case B.Invalid{}:
      B.Invalid{}
    case B.Valid{value}:
      combine_element(T, A, reduce, value, element)

def advance(~T: Data, ~S: Data, ~A: Data, ~capacity: U32,
    ~read: S -> U32 -> T, ~reduce: A -> T -> B.Result<A>,
    cursor: Cursor<T, S, A>) -> Cursor<T, S, A>:
  match cursor:
    case Cursor{+vector, +index, accumulator}:
      Cursor{vector, U32.add(index, 1),
        combine(T, A, reduce, accumulator, B.get(T, S, capacity, read, vector, index))}

def finish_checked(~A: Data, accumulator: B.Result<A>, valid: Bool) -> B.Result<A>:
  match valid:
    case True{}:
      accumulator
    case False{}:
      B.Invalid{}

def finish(~T: Data, ~S: Data, ~A: Data, ~capacity: U32,
    cursor: Cursor<T, S, A>) -> B.Result<A>:
  match cursor:
    case Cursor{B.Vector{+length, storage}, index, accumulator}:
      finish_checked(A, accumulator, Bool.and(U32.is_ge(capacity, length), U32.is_eq(index, length)))

def fold(~T: Data, ~S: Data, ~A: Data, ~capacity: U32,
    ~read: S -> U32 -> T, ~reduce: A -> T -> B.Result<A>,
    fuel: Nat, vector: B.Vector<T, S>, initial: A) -> B.Result<A>:
  finish(T, S, A, capacity,
    I.repeat(Cursor<T, S, A>,
      cursor => advance(T, S, A, capacity, read, reduce, cursor),
      fuel, Cursor{vector, 0, B.Valid{initial}}))
