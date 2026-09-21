import Base
import ../sdk/iteration.bend as I

type State is Data:
  State{left: U32, right: U32}

def increment(value: U32) -> U32:
  U32.add(value, 1)

def swap(state: State) -> State:
  match state:
    case State{left, right}:
      State{right, left}

def count(fuel: Nat, value: U32) -> U32:
  I.repeat(U32, increment, fuel, value)

def swaps(fuel: Nat, state: State) -> State:
  I.repeat(State, swap, fuel, state)

def toggle(fuel: Nat, value: Bool) -> Bool:
  I.repeat(Bool, Bool.not, fuel, value)

# Multiple mutable loop arguments exercise simultaneous assignment.
def rotate(fuel: Nat, left: U32, right: U32) -> State:
  match fuel:
    case Zero{}:
      State{left, right}
    case Succ{pred}:
      rotate(pred, right, left)
