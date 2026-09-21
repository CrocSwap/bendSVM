import ../sdk/collection.bend as Sol
import ../sdk/buffer.bend as B
import ../sdk/cpi.bend as Cpi

# Executor fixture, not an application: the caller chooses the CPI capability.
type State is Data:
  State{count: U32}

type Instruction is Data:
  Run{effect: Cpi.Effect}

type Outcome is Data:
  Accepted{state: State, window: Sol.Window<U32, B.Pair<U32>>, length: U32, effects: Cpi.Effects}
  Rejected{code: U32}

def select(context: Sol.Context, state: State, instruction: Instruction, metadata: Sol.Metadata) -> B.Result<Sol.Range>:
  B.Valid{Sol.Range{0, 0}}

def next(state: State, instruction: Instruction, window: Sol.Window<U32, B.Pair<U32>>, length: U32) -> Outcome:
  match state instruction:
    case State{count} Run{effect}:
      Accepted{State{U32.add(count, 1)}, window, length, Cpi.one(effect)}

def process(context: Sol.Context, state: State, instruction: Instruction, metadata: Sol.Metadata, window: Sol.Window<U32, B.Pair<U32>>) -> Outcome:
  match metadata:
    case Sol.Metadata{length, capacity}:
      next(state, instruction, window, length)
