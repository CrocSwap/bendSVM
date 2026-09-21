import ../sdk/context.bend as Sol
import ../sdk/cpi.bend as Cpi
import ./cpi-pair.bend as Pair

type FirstState is Data:
  FirstState{count: U32}

type SecondState is Data:
  SecondState{count: U32}

type ThirdState is Data:
  ThirdState{count: U32}

type State is Data:
  State{first: FirstState, second: SecondState, third: ThirdState}

type Outcome is Data:
  Accepted{state: State, effects: Cpi.Effects}
  Rejected{code: U32}

def process(context: Sol.Context, state: State, instruction: Pair.Instruction) -> Outcome:
  match state instruction:
    case State{FirstState{first}, SecondState{second}, ThirdState{third}} Pair.Run{effect, second_data}:
      Accepted{State{FirstState{U32.add(first, 1)}, SecondState{U32.add(second, 2)}, ThirdState{U32.add(third, 3)}}, Pair.pair(effect, second_data)}
