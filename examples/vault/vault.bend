import ../../sdk/context.bend as Sol
import ../../sdk/math.bend as Math
import ../../sdk/effects.bend as Fx

type State is Data:
  Empty{}
  Live{owner: Sol.Key, mint: Sol.Key, balance: Math.U64}

type Instruction is Data:
  Initialize{mint: Sol.Key}
  Deposit{amount: Math.U64}
  Withdraw{amount: Math.U64}

type Outcome is Data:
  Accepted{state: State, effects: Fx.Effects}
  Rejected{code: U32}

def authorize(allowed: Bool, result: Outcome) -> Outcome:
  match allowed:
    case False{}:
      Rejected{1}
    case True{}:
      result

def deposited(owner: Sol.Key, +mint: Sol.Key, amount: Math.U64, sum: Math.Checked) -> Outcome:
  match sum:
    case Math.Err{code}:
      Rejected{4}
    case Math.Ok{balance}:
      Accepted{Live{owner, mint, balance}, Fx.one(Fx.Transfer{4, 5, 6, mint, Fx.ToCustody{}, amount, Fx.Actor{}})}

def withdrawn(owner: Sol.Key, +mint: Sol.Key, amount: Math.U64, difference: Math.Checked) -> Outcome:
  match difference:
    case Math.Err{code}:
      Rejected{5}
    case Math.Ok{balance}:
      Accepted{Live{owner, mint, balance}, Fx.one(Fx.Transfer{4, 5, 6, mint, Fx.ToActor{}, amount, Fx.Custody{}})}

def live(owner: Sol.Key, mint: Sol.Key, balance: Math.U64, instruction: Instruction) -> Outcome:
  match instruction:
    case Initialize{ignored}:
      Rejected{3}
    case Deposit{+amount}:
      deposited(owner, mint, amount, Math.add(balance, amount))
    case Withdraw{+amount}:
      withdrawn(owner, mint, amount, Math.sub(balance, amount))

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match context:
    case Sol.Context{+actor, signed, slot}:
      match state:
        case Empty{}:
          match instruction:
            case Initialize{+mint}:
              authorize(signed, Accepted{Live{actor, mint, Math.zero()}, Fx.one(Fx.CheckMint{4, mint})})
            case Deposit{amount}:
              Rejected{2}
            case Withdraw{amount}:
              Rejected{2}
        case Live{+owner, mint, balance}:
          authorize(Bool.and(signed, Sol.equal(actor, owner)), live(owner, mint, balance, instruction))
