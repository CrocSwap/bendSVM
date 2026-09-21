import Base
import @SDK@/collection.bend as C
import @SDK@/buffer.bend as B
import @SDK@/context.bend as Sol

# A signed owner controls this collection. Records live in a separate account;
# only the selected window enters the transition on each call.
type State is Data:
  Empty{}
  Ready{owner: Sol.Key, collection: Sol.Key}

type Instruction is Data:
  Initialize{}
  Append{value: U32}
  Replace{index: U32, value: U32}

type Outcome is Data:
  Accepted{state: State, window: C.Window<U32, B.Pair<U32>>, length: U32}
  Rejected{code: U32}

def select(context: C.Context, state: State, instruction: Instruction, +metadata: C.Metadata) -> B.Result<C.Range>:
  match instruction metadata:
    case Initialize{} C.Metadata{length, capacity}:
      C.read_range(metadata, 0, 0, 2)
    case Append{value} C.Metadata{length, capacity}:
      C.reserve_range(metadata, length, 1, 2)
    case Replace{index, value} C.Metadata{length, capacity}:
      C.read_range(metadata, index, 1, 2)

def initialized(valid: Bool, owner: Sol.Key, collection: Sol.Key, window: C.Window<U32, B.Pair<U32>>) -> Outcome:
  match valid:
    case True{}:
      Accepted{Ready{owner, collection}, window, 0}
    case False{}:
      Rejected{1}

def initialize(context: C.Context, window: C.Window<U32, B.Pair<U32>>, length: U32) -> Outcome:
  match context:
    case C.Context{owner, signed, slot, collection}:
      initialized(Bool.and(signed, U32.is_zero(length)), owner, collection, window)

def start(context: C.Context, instruction: Instruction, length: U32, window: C.Window<U32, B.Pair<U32>>) -> Outcome:
  match instruction:
    case Initialize{}:
      initialize(context, window, length)
    case Append{value}:
      Rejected{2}
    case Replace{index, value}:
      Rejected{2}

def finish(+state: State, result: B.Result<C.Window<U32, B.Pair<U32>>>, length: U32) -> Outcome:
  match result:
    case B.Invalid{}:
      Rejected{3}
    case B.Valid{value}:
      Accepted{state, value, length}

def apply(state: State, instruction: Instruction, length: U32, window: C.Window<U32, B.Pair<U32>>) -> Outcome:
  match instruction:
    case Initialize{}:
      Rejected{2}
    case Append{value}:
      finish(state, C.push(U32, B.Pair<U32>, 2, storage => index => value => B.pair_set(U32, storage, index, value), window, value), U32.add(length, 1))
    case Replace{index, value}:
      finish(state, C.set(U32, B.Pair<U32>, 2, storage => index => value => B.pair_set(U32, storage, index, value), window, index, value), length)

def dispatch(valid: Bool, state: State, instruction: Instruction, length: U32, window: C.Window<U32, B.Pair<U32>>) -> Outcome:
  match valid:
    case True{}:
      apply(state, instruction, length, window)
    case False{}:
      Rejected{1}

def allowed(context: C.Context, owner: Sol.Key, collection: Sol.Key) -> Bool:
  match context:
    case C.Context{actor, signed, slot, actual}:
      Bool.and(signed, Bool.and(Sol.equal(actor, owner), Sol.equal(actual, collection)))

def transition(+context: C.Context, state: State, instruction: Instruction, length: U32, window: C.Window<U32, B.Pair<U32>>) -> Outcome:
  match state:
    case Empty{}:
      start(context, instruction, length, window)
    case Ready{+owner, +collection}:
      dispatch(allowed(context, owner, collection), Ready{owner, collection}, instruction, length, window)

def process(context: C.Context, state: State, instruction: Instruction, metadata: C.Metadata, window: C.Window<U32, B.Pair<U32>>) -> Outcome:
  match metadata:
    case C.Metadata{length, capacity}:
      transition(context, state, instruction, length, window)
