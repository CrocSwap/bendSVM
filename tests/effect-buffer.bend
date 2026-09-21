import ../sdk/context.bend as Sol
import ../sdk/buffer.bend as B
import ../sdk/issuance.bend as Fx

type State is Data:
  State{count: U32}

type Instruction is Data:
  Run{effects: B.Vector<Fx.Effect, B.Pair<B.Pair<Fx.Effect>>>}

type Outcome is Data:
  Accepted{state: State, effects: B.Vector<Fx.Effect, B.Pair<B.Pair<Fx.Effect>>>}
  Rejected{code: U32}

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match state instruction:
    case State{count} Run{effects}:
      Accepted{State{U32.add(count, 1)}, effects}
