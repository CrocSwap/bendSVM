import ../sdk/context.bend as Sol
import ../sdk/effects.bend as Fx
import ../sdk/math.bend as Math

# Test probe deliberately lets the caller choose both amounts. It tests the
# shared two-effect executor, and is not a custody application.
type State is Data:
  State{count: U32}

type Instruction is Data:
  RoundTrip{mint: Sol.Key, deposit: Math.U64, withdrawal: Math.U64}

type Outcome is Data:
  Accepted{state: State, effects: Fx.Effects}
  Rejected{code: U32}

def authorize(signed: Bool, result: Outcome) -> Outcome:
  match signed:
    case False{}:
      Rejected{1}
    case True{}:
      result

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match context state instruction:
    case Sol.Context{actor, signed, slot} State{count} RoundTrip{+mint, deposit, withdrawal}:
      authorize(signed, Accepted{State{U32.add(count, 1)}, Fx.Effects{
        Fx.Transfer{4, 5, 6, mint, Fx.ToCustody{}, deposit, Fx.Actor{}},
        Fx.Transfer{5, 4, 6, mint, Fx.ToActor{}, withdrawal, Fx.Custody{}}}})
