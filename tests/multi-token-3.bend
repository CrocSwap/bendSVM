import ../sdk/context.bend as Sol
import ../sdk/math.bend as Math
import ../sdk/effects.bend as Fx

# Executor probe: caller-controlled amounts; not a custody application.
type FirstCounter is Data:
  FirstCounter{count: U32}

type SecondCounter is Data:
  SecondCounter{count: U32}

type ThirdCounter is Data:
  ThirdCounter{count: U32}

type State is Data:
  State{first: FirstCounter, second: SecondCounter, third: ThirdCounter}

type Instruction is Data:
  RoundTrip{mint: Sol.Key, deposit: Math.U64, withdrawal: Math.U64}

type Outcome is Data:
  Accepted{state: State, effects: Fx.Effects}
  Rejected{code: U32}

def authorize(signed: Bool, outcome: Outcome) -> Outcome:
  match signed:
    case False{}:
      Rejected{1}
    case True{}:
      outcome

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match context state instruction:
    case Sol.Context{actor, signed, slot} State{FirstCounter{first}, SecondCounter{second}, ThirdCounter{third}} RoundTrip{+mint, deposit, withdrawal}:
      authorize(signed, Accepted{State{FirstCounter{U32.add(first, 1)}, SecondCounter{U32.add(second, 1)}, ThirdCounter{U32.add(third, 1)}}, Fx.Effects{
        Fx.Transfer{6, 7, 8, mint, Fx.ToCustody{}, deposit, Fx.Actor{}},
        Fx.Transfer{7, 6, 8, mint, Fx.ToActor{}, withdrawal, Fx.Custody{}}}})
