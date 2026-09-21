import ../sdk/context.bend as Sol
import ../sdk/math.bend as Math

type State is Data:
  Empty{}
  Stored{owner: Sol.Key, value: U32, slot: Math.U64}

type Instruction is Data:
  Initialize{value: U32}
  Set{value: U32}

type Outcome is Data:
  Accepted{state: State}
  Rejected{code: U32}

def update(authorized: Bool, owner: Sol.Key, value: U32, slot: Math.U64) -> Outcome:
  match authorized:
    case False{}:
      Rejected{1}
    case True{}:
      Accepted{Stored{owner, value, slot}}

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match context:
    case Sol.Context{+actor, signed, slot}:
      match state instruction:
        case Empty{} Initialize{value}:
          update(signed, actor, value, slot)
        case Stored{+owner, old, old_slot} Set{value}:
          update(Bool.and(signed, Sol.equal(actor, owner)), owner, value, slot)
        case Empty{} Set{value}:
          Rejected{2}
        case Stored{owner, old, old_slot} Initialize{value}:
          Rejected{3}

law unsigned_rejected:
  for actor: Sol.Key
  for slot: Math.U64
  for value: U32
  {process(Sol.Context{actor, False{}, slot}, Empty{}, Initialize{value}) == Rejected{1} : Outcome}

def unsigned_rejected(actor, slot, value):
  {==}
