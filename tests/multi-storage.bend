import ../sdk/context.bend as Sol

type Cell is Data:
  Cell{value: U32}

type State is Data:
  State{left: Cell, right: Cell}

type Instruction is Data:
  Set{left: U32, right: U32}
  AbortRequest{}

type Outcome is Data:
  Accepted{state: State}
  Rejected{code: U32}

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match instruction:
    case Set{left, right}:
      Accepted{State{Cell{left}, Cell{right}}}
    case AbortRequest{}:
      Rejected{42}
