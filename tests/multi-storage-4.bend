import ../sdk/context.bend as Sol

type FirstCell is Data:
  FirstCell{value: U32}

type SecondCell is Data:
  SecondCell{value: U32}

type ThirdCell is Data:
  ThirdCell{value: U32}

type FourthCell is Data:
  FourthCell{value: U32}

type State is Data:
  State{first: FirstCell, second: SecondCell, third: ThirdCell, fourth: FourthCell}

type Instruction is Data:
  Set{first: U32, second: U32, third: U32, fourth: U32}
  Rotate{}
  AbortRequest{}

type Outcome is Data:
  Accepted{state: State}
  Rejected{code: U32}

def rotate(state: State) -> State:
  match state:
    case State{FirstCell{first}, SecondCell{second}, ThirdCell{third}, FourthCell{fourth}}:
      State{FirstCell{second}, SecondCell{third}, ThirdCell{fourth}, FourthCell{first}}

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match instruction:
    case Set{first, second, third, fourth}:
      Accepted{State{FirstCell{first}, SecondCell{second}, ThirdCell{third}, FourthCell{fourth}}}
    case Rotate{}:
      Accepted{rotate(state)}
    case AbortRequest{}:
      Rejected{42}
