import ../sdk/context.bend as Sol
import ../sdk/math.bend as Math
import ../sdk/effects.bend as Fx
import ../sdk/issuance.bend as Token

# Executor probe only: caller-controlled issuance is NOT an application policy.
type State is Data:
  State{count: U32}

type Instruction is Data:
  Run{mint: Sol.Key, issued: Math.U64, transferred: Math.U64, burned: Math.U64, initialize: Bool, vault: Sol.Key, source_binding: Token.Binding}

type Outcome is Data:
  Accepted{state: State, effects: Token.Effects}
  Rejected{code: U32}

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match state instruction:
    case State{count} Run{+mint, issued, transferred, burned, +initialize, vault, source_binding}:
      Accepted{State{U32.add(count, 1)}, Token.Effects{
        Token.Mint{4, 6, mint, Fx.ToActor{}, issued, initialize},
        Token.BoundTransfer{Token.TransferDetails{4, 5, 6, mint, Fx.ToCustody{}, transferred, Fx.Actor{}}, source_binding, Token.Exact{vault}, initialize},
        Token.Burn{4, 6, mint, burned}}}
