import Base

type Decision is Data:
  Accepted{value: U32}
  Refused{observed: U32}

type Request is Data:
  Run{enabled: Bool, value: U32}
  Stop{}

def decide(below: Bool, value: U32) -> Decision:
  match below:
    case True{}:
      Accepted{U32.add(value, 2)}
    case False{}:
      Refused{value}

def evaluate(+request: Request) -> Decision:
  match request:
    case Run{enabled, value}:
      match enabled:
        case True{}:
          decide(U32.is_lt(value, 41), value)
        case False{}:
          Refused{value}
    case Stop{}:
      Refused{0}

def evaluate_alt(+request: Request) -> Decision:
  evaluate(request)
