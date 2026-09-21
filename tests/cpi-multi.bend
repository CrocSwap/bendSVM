import ../sdk/context.bend as Sol
import ../sdk/cpi.bend as Cpi
import ./cpi-pair.bend as Pair

type Left is Data:
  Left{count: U32}

type Right is Data:
  Right{count: U32}

type State is Data:
  State{left: Left, right: Right}

type Outcome is Data:
  Accepted{state: State, effects: Cpi.Effects}
  Rejected{code: U32}

def process(context: Sol.Context, state: State, instruction: Pair.Instruction) -> Outcome:
  match state instruction:
    case State{Left{a}, Right{b}} Pair.Run{effect, second_data}:
      Accepted{State{Left{U32.add(a, 1)}, Right{U32.add(b, 2)}}, Pair.pair(effect, second_data)}
