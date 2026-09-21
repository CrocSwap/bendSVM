import ../sdk/context.bend as Sol
import ../sdk/cpi.bend as Cpi

# Executor fixture, not an application: the caller chooses the CPI capability.
type State is Data:
  State{count: U32}

type Instruction is Data:
  Run{effect: Cpi.Effect}

type Outcome is Data:
  Accepted{state: State, effects: Cpi.Effects}
  Rejected{code: U32}

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match state instruction:
    case State{count} Run{effect}:
      Accepted{State{U32.add(count, 1)}, Cpi.one(effect)}
