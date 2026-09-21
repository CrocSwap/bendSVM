import ../sdk/context.bend as Sol
import ../sdk/math.bend as Math
import ../sdk/effects.bend as Fx
import ../sdk/effects3.bend as Batch

# Shared executor test, not an authorization policy or a custody application.
type State is Data:
  State{count: U32}

type Instruction is Data:
  Run{mint: Sol.Key, first: Math.U64, second: Math.U64, third: Math.U64, last_mint: U32}

type Outcome is Data:
  Accepted{state: State, effects: Batch.Effects}
  Rejected{code: U32}

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match state instruction:
    case State{count} Run{+mint, first, second, third, last_mint}:
      Accepted{State{U32.add(count, 1)}, Batch.Effects{
        Fx.Transfer{4, 5, 6, mint, Fx.ToCustody{}, first, Fx.Actor{}},
        Fx.Transfer{4, 5, 6, mint, Fx.ToCustody{}, second, Fx.Actor{}},
        Fx.Transfer{5, 4, last_mint, mint, Fx.ToActor{}, third, Fx.Custody{}}}}
