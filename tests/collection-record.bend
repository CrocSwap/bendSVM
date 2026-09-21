import Base
import ../sdk/collection.bend as C
import ../sdk/buffer.bend as B

type Item is Data:
  Item{enabled: Bool, value: U32}

type State is Data:
  State{calls: U32}

type Instruction is Data:
  Append{value: Item}
  Replace{index: U32, value: Item}

type Outcome is Data:
  Accepted{state: State, window: C.Window<Item, B.Pair<B.Pair<Item>>>, length: U32}
  Rejected{code: U32}

def select(context: C.Context, state: State, instruction: Instruction, +metadata: C.Metadata) -> B.Result<C.Range>:
  match instruction metadata:
    case Append{value} C.Metadata{length, capacity}:
      C.reserve_range(metadata, length, 1, 4)
    case Replace{index, value} C.Metadata{length, capacity}:
      C.read_range(metadata, index, 1, 4)

def finish(+state: State, result: B.Result<C.Window<Item, B.Pair<B.Pair<Item>>>>, length: U32) -> Outcome:
  match result:
    case B.Invalid{}:
      Rejected{1}
    case B.Valid{value}:
      Accepted{state, value, length}

def apply(calls: U32, instruction: Instruction, length: U32, window: C.Window<Item, B.Pair<B.Pair<Item>>>) -> Outcome:
  match instruction:
    case Append{value}:
      finish(State{U32.add(calls, 1)}, C.push(Item, B.Pair<B.Pair<Item>>, 4, storage => index => value => B.quad_set(Item, storage, index, value), window, value), U32.add(length, 1))
    case Replace{index, value}:
      finish(State{U32.add(calls, 1)}, C.set(Item, B.Pair<B.Pair<Item>>, 4, storage => index => value => B.quad_set(Item, storage, index, value), window, index, value), length)

def process(context: C.Context, state: State, instruction: Instruction, metadata: C.Metadata, window: C.Window<Item, B.Pair<B.Pair<Item>>>) -> Outcome:
  match state:
    case State{calls}:
      match metadata:
        case C.Metadata{length, capacity}:
          apply(calls, instruction, length, window)
