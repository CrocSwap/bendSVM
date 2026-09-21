import Base
import ../sdk/collection.bend as C
import ../sdk/buffer.bend as B

type State is Data:
  State{calls: U32}

type Instruction is Data:
  Append{value: U32}
  Replace{index: U32, value: U32}
  Attack{mode: U32}

type Outcome is Data:
  Accepted{state: State, window: C.Window<U32, B.Pair<U32>>, length: U32}
  Rejected{code: U32}

def select(context: C.Context, state: State, instruction: Instruction, +metadata: C.Metadata) -> B.Result<C.Range>:
  match instruction metadata:
    case Append{value} C.Metadata{length, capacity}:
      C.reserve_range(metadata, length, 1, 2)
    case Replace{index, value} C.Metadata{length, capacity}:
      C.read_range(metadata, index, 1, 2)
    case Attack{mode} C.Metadata{length, capacity}:
      C.read_range(metadata, 0, 1, 2)

def finish(+state: State, result: B.Result<C.Window<U32, B.Pair<U32>>>, length: U32) -> Outcome:
  match result:
    case B.Invalid{}:
      Rejected{1}
    case B.Valid{value}:
      Accepted{state, value, length}

def attack(state: State, +mode: U32, +length: U32, window: C.Window<U32, B.Pair<U32>>) -> Outcome:
  match window:
    case C.Window{+start, B.Vector{count, storage}}:
      Accepted{state, C.Window{B.pick(U32, U32.add(start, 1), start, U32.is_eq(mode, 0)),
        B.Vector{B.pick(U32, 0, count, U32.is_eq(mode, 1)), storage}},
        B.pick(U32, U32.add(length, 1), length, U32.is_eq(mode, 2))}

def apply(calls: U32, instruction: Instruction, length: U32, window: C.Window<U32, B.Pair<U32>>) -> Outcome:
  match instruction:
    case Append{value}:
      finish(State{U32.add(calls, 1)}, C.push(U32, B.Pair<U32>, 2, storage => index => value => B.pair_set(U32, storage, index, value), window, value), U32.add(length, 1))
    case Replace{index, value}:
      finish(State{U32.add(calls, 1)}, C.set(U32, B.Pair<U32>, 2, storage => index => value => B.pair_set(U32, storage, index, value), window, index, value), length)
    case Attack{mode}:
      attack(State{U32.add(calls, 1)}, mode, length, window)

def process(context: C.Context, state: State, instruction: Instruction, metadata: C.Metadata, window: C.Window<U32, B.Pair<U32>>) -> Outcome:
  match state:
    case State{calls}:
      match metadata:
        case C.Metadata{length, capacity}:
          apply(calls, instruction, length, window)
