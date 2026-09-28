import Base
import ../sdk/iteration.bend as Iter

type Sample is Data:
  Sample{left: U32, right: U32}

type Payload is Data:
  Empty{}
  Word{value: U32}
  State{enabled: Bool, pair: Sample}

def swap(pair: Sample) -> Sample:
  match pair:
    case Sample{left, right}:
      Sample{right, left}

def select(flag: Bool, pair: Sample) -> U32:
  match flag pair:
    case False{} Sample{left, right}:
      left
    case True{} Sample{left, right}:
      right

def update(flag: Bool, pair: Sample, bias: U32) -> Payload:
  match flag:
    case False{}:
      reversed = swap(pair)
      chosen = select(False{}, reversed)
      Word{U32.add(chosen, bias)}
    case True{}:
      reversed = swap(pair)
      chosen = select(True{}, reversed)
      State{False{}, Sample{chosen, bias}}

def normalize(payload: Payload) -> Payload:
  match payload:
    case Empty{}:
      Empty{}
    case Word{value}:
      Word{U32.not(value)}
    case State{enabled, Sample{left, right}}:
      State{Bool.not(enabled), Sample{right, left}}

def increment(value: U32) -> U32:
  U32.add(value, 1)

def iterate(fuel: Nat, value: U32) -> U32:
  Iter.repeat(U32, increment, fuel, value)

def identity(payload: Payload) -> Payload:
  payload

law identity_preserves:
  for payload: Payload
  {identity(payload) == payload : Payload}

def identity_preserves(payload):
  {==}
