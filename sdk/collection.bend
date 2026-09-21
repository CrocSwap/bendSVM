import Base
import ./buffer.bend as B
import ./context.bend as C
import ./math.bend as M

# Collection key is runtime-supplied, so source state can bind its allocation.
type Context is Data:
  Context{actor: C.Key, signed: Bool, slot: M.U64, collection: C.Key}

# Account metadata is small even when the allocation contains many records.
type Metadata is Data:
  Metadata{length: U32, capacity: U32}

type Range is Data:
  Range{start: U32, count: U32}

# A loaded window contains active records only. Its backing storage has a fixed
# per-call capacity, independent of the collection account's physical capacity.
type Window<-T: Data, -S: Data> is Data:
  Window{start: U32, entries: B.Vector<T, S>}

def choose_range(+start: U32, +count: U32, valid: Bool) -> B.Result<Range>:
  match valid:
    case True{}:
      B.Valid{Range{start, count}}
    case False{}:
      B.Invalid{}

# Test subtraction only together with start <= limit. Never accept wrapped
# start + count arithmetic as evidence that a window fits.
def fits(+start: U32, +count: U32, +limit: U32) -> Bool:
  Bool.and(U32.is_ge(limit, start), U32.is_ge(U32.sub(limit, start), count))

def read_range(metadata: Metadata, +start: U32, +count: U32, +maximum: U32) -> B.Result<Range>:
  match metadata:
    case Metadata{+length, capacity}:
      choose_range(start, count,
        Bool.and(U32.is_ge(capacity, length),
          Bool.and(U32.is_ge(maximum, count), fits(start, count, length))))

# A reservation may include inactive slots for an append. Starting beyond the
# current length is forbidden, because it would leave uninitialized holes.
def reserve_range(metadata: Metadata, +start: U32, +count: U32, +maximum: U32) -> B.Result<Range>:
  match metadata:
    case Metadata{+length, +capacity}:
      choose_range(start, count,
        Bool.and(U32.is_ge(capacity, length),
          Bool.and(U32.is_ge(length, start),
            Bool.and(U32.is_ge(maximum, count), fits(start, count, capacity)))))

def get_from(~T: Data, ~S: Data, ~capacity: U32, ~read: S -> U32 -> T,
    entries: B.Vector<T, S>, local: U32, valid: Bool) -> B.Result<T>:
  match valid:
    case True{}:
      B.get(T, S, capacity, read, entries, local)
    case False{}:
      B.Invalid{}

def get(~T: Data, ~S: Data, ~capacity: U32, ~read: S -> U32 -> T,
    window: Window<T, S>, +index: U32) -> B.Result<T>:
  match window:
    case Window{+start, entries}:
      get_from(T, S, capacity, read, entries, U32.sub(index, start), U32.is_ge(index, start))

def wrap(~T: Data, ~S: Data, start: U32, result: B.Result<B.Vector<T, S>>) -> B.Result<Window<T, S>>:
  match result:
    case B.Invalid{}:
      B.Invalid{}
    case B.Valid{value}:
      B.Valid{Window{start, value}}

def set_from(~T: Data, ~S: Data, ~capacity: U32, ~write: S -> U32 -> T -> S,
    +start: U32, entries: B.Vector<T, S>, local: U32, value: T, valid: Bool) -> B.Result<Window<T, S>>:
  match valid:
    case True{}:
      wrap(T, S, start, B.set(T, S, capacity, write, entries, local, value))
    case False{}:
      B.Invalid{}

def set(~T: Data, ~S: Data, ~capacity: U32, ~write: S -> U32 -> T -> S,
    window: Window<T, S>, +index: U32, value: T) -> B.Result<Window<T, S>>:
  match window:
    case Window{+start, entries}:
      set_from(T, S, capacity, write, start, entries, U32.sub(index, start), value, U32.is_ge(index, start))

# This grows only the loaded window. The adapter separately validates that it
# reaches the collection tail and that the account has room for the new record.
def push(~T: Data, ~S: Data, ~capacity: U32, ~write: S -> U32 -> T -> S,
    window: Window<T, S>, value: T) -> B.Result<Window<T, S>>:
  match window:
    case Window{start, entries}:
      wrap(T, S, start, B.push(T, S, capacity, write, entries, value))
