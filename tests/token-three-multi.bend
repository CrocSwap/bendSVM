import ../sdk/context.bend as Sol
import ../sdk/effects.bend as Fx
import ../sdk/effects3.bend as Batch
import ./token-three.bend as Probe

type State is Data:
  State{first: Probe.State, second: Probe.State}

type Outcome is Data:
  Accepted{state: State, effects: Batch.Effects}
  Rejected{code: U32}

def process(context: Sol.Context, state: State, instruction: Probe.Instruction) -> Outcome:
  match state instruction:
    case State{Probe.State{left}, Probe.State{right}} Probe.Run{+mint, first, second, third, last_mint}:
      Accepted{State{Probe.State{U32.add(left, 1)}, Probe.State{U32.add(right, 2)}}, Batch.Effects{
        Fx.Transfer{5, 6, 7, mint, Fx.ToCustody{}, first, Fx.Actor{}},
        Fx.Transfer{5, 6, 7, mint, Fx.ToCustody{}, second, Fx.Actor{}},
        Fx.Transfer{6, 5, last_mint, mint, Fx.ToActor{}, third, Fx.Custody{}}}}
