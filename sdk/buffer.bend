import Base

# Fixed storage and vector operations are ordinary checked Bend definitions.
# Storage adapters are compile-time parameters, never runtime closures.
type Pair<-T: Data> is Data:
  Pair{left: T, right: T}

type Vector<-T: Data, -S: Data> is Data:
  Vector{length: U32, storage: S}

type Result<-T: Data> is Data:
  Invalid{}
  Valid{value: T}

def pick(~T: Data, +left: T, +right: T, +first: Bool) -> T:
  match first:
    case True{}:
      left
    case False{}:
      right

def pair_get(~T: Data, +pair: Pair<T>, +index: U32) -> T:
  match pair:
    case Pair{left, right}:
      pick(T, left, right, U32.is_zero(index))

def replace_pair(~T: Data, +left: T, +right: T, +value: T, +first: Bool) -> Pair<T>:
  match first:
    case True{}:
      Pair{value, right}
    case False{}:
      Pair{left, value}

def pair_set(~T: Data, +pair: Pair<T>, +index: U32, +value: T) -> Pair<T>:
  match pair:
    case Pair{left, right}:
      replace_pair(T, left, right, value, U32.is_zero(index))

def quad_get(~T: Data, +storage: Pair<Pair<T>>, +index: U32) -> T:
  pair_get(T, pair_get(Pair<T>, storage, U32.div(index, 2)), U32.and(index, 1))

def quad_set(~T: Data, +storage: Pair<Pair<T>>, +index: U32, +value: T) -> Pair<Pair<T>>:
  +half = U32.div(index, 2)
  pair = pair_get(Pair<T>, storage, half)
  pair_set(Pair<T>, storage, half, pair_set(T, pair, U32.and(index, 1), value))

def empty(~T: Data, ~S: Data, +storage: S) -> Vector<T, S>:
  Vector{0, storage}

def get_checked(~T: Data, ~S: Data, ~read: S -> U32 -> T,
    +storage: S, +index: U32, +valid: Bool) -> Result<T>:
  match valid:
    case True{}:
      Valid{read(storage, index)}
    case False{}:
      Invalid{}

def get(~T: Data, ~S: Data, ~capacity: U32, ~read: S -> U32 -> T,
    +vector: Vector<T, S>, +index: U32) -> Result<T>:
  match vector:
    case Vector{+length, storage}:
      get_checked(T, S, read, storage, index,
        Bool.and(U32.is_ge(capacity, length), U32.is_lt(index, length)))

def write_checked(~T: Data, ~S: Data, ~write: S -> U32 -> T -> S,
    +storage: S, +index: U32, +value: T, +length: U32, +valid: Bool) -> Result<Vector<T, S>>:
  match valid:
    case True{}:
      Valid{Vector{length, write(storage, index, value)}}
    case False{}:
      Invalid{}

def set(~T: Data, ~S: Data, ~capacity: U32, ~write: S -> U32 -> T -> S,
    +vector: Vector<T, S>, +index: U32, +value: T) -> Result<Vector<T, S>>:
  match vector:
    case Vector{+length, storage}:
      write_checked(T, S, write, storage, index, value, length,
        Bool.and(U32.is_ge(capacity, length), U32.is_lt(index, length)))

def push(~T: Data, ~S: Data, ~capacity: U32, ~write: S -> U32 -> T -> S,
    +vector: Vector<T, S>, +value: T) -> Result<Vector<T, S>>:
  match vector:
    case Vector{+length, storage}:
      write_checked(T, S, write, storage, length, value, U32.add(length, 1),
        U32.is_lt(length, capacity))
