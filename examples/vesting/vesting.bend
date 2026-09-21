import ../../sdk/context.bend as Sol
import ../../sdk/math.bend as Math
import ../../sdk/wide.bend as Wide
import ../../sdk/effects.bend as Fx

type Schedule is Data:
  Schedule{beneficiary: Sol.Key, mint: Sol.Key, total: Math.U64, start: Math.U64, end: Math.U64, claimed: Math.U64}

type State is Data:
  Empty{}
  Live{schedule: Schedule}

type Instruction is Data:
  Initialize{beneficiary: Sol.Key, mint: Sol.Key, total: Math.U64, start: Math.U64, end: Math.U64}
  Claim{}

type Outcome is Data:
  Accepted{state: State, effects: Fx.Effects}
  Rejected{code: U32}

def authorize(allowed: Bool, outcome: Outcome) -> Outcome:
  match allowed:
    case False{}:
      Rejected{1}
    case True{}:
      outcome

def initialize(valid: Bool, beneficiary: Sol.Key, +mint: Sol.Key, +total: Math.U64, start: Math.U64, end: Math.U64) -> Outcome:
  match valid:
    case False{}:
      Rejected{3}
    case True{}:
      Accepted{Live{Schedule{beneficiary, mint, total, start, end, Math.zero()}}, Fx.one(Fx.Transfer{4, 5, 6, mint, Fx.ToCustody{}, total, Fx.Actor{}})}

def timed(before: Bool, after: Bool, total: Math.U64, +start: Math.U64, end: Math.U64, now: Math.U64) -> Math.Checked:
  match before after:
    case True{} True{}:
      Math.Ok{Math.zero()}
    case True{} False{}:
      Math.Ok{Math.zero()}
    case False{} True{}:
      Math.Ok{total}
    case False{} False{}:
      Wide.floor(total, Math.sub_wrap(now, start), Math.sub_wrap(end, start))

def entitlement(+total: Math.U64, +start: Math.U64, +end: Math.U64, +now: Math.U64) -> Math.Checked:
  timed(Bool.not(Math.less(start, now)), Bool.not(Math.less(now, end)), total, start, end, now)

def transfer(schedule: Schedule, amount: Math.U64) -> Outcome:
  match schedule:
    case Schedule{+beneficiary, +mint, total, start, end, claimed}:
      Accepted{Live{Schedule{beneficiary, mint, total, start, end, claimed}}, Fx.one(Fx.Transfer{4, 5, 6, mint, Fx.ToOwner{beneficiary}, amount, Fx.Custody{}})}

def payout(nonzero: Bool, schedule: Schedule, amount: Math.U64) -> Outcome:
  match nonzero:
    case False{}:
      Rejected{6}
    case True{}:
      transfer(schedule, amount)

def delta(schedule: Schedule, result: Math.Checked) -> Outcome:
  match result:
    case Math.Err{code}:
      Rejected{5}
    case Math.Ok{+amount}:
      payout(Bool.not(Math.equal(amount, Math.zero())), schedule, amount)

def difference(schedule: Schedule, +vested: Math.U64) -> Outcome:
  match schedule:
    case Schedule{beneficiary, mint, total, start, end, claimed}:
      delta(Schedule{beneficiary, mint, total, start, end, vested}, Math.sub(vested, claimed))

def bounded(over: Bool, schedule: Schedule, vested: Math.U64) -> Outcome:
  match over:
    case True{}:
      Rejected{4}
    case False{}:
      difference(schedule, vested)

def funded_total(schedule: Schedule) -> Math.U64:
  match schedule:
    case Schedule{beneficiary, mint, total, start, end, claimed}:
      total

def claim_result(+schedule: Schedule, result: Math.Checked) -> Outcome:
  match result:
    case Math.Err{code}:
      Rejected{4}
    case Math.Ok{+vested}:
      bounded(Math.less(funded_total(schedule), vested), schedule, vested)

def claim(schedule: Schedule, now: Math.U64) -> Outcome:
  match schedule:
    case Schedule{beneficiary, mint, +total, +start, +end, claimed}:
      claim_result(Schedule{beneficiary, mint, total, start, end, claimed}, entitlement(total, start, end, now))

def live_claim(context: Sol.Context, schedule: Schedule) -> Outcome:
  match context schedule:
    case Sol.Context{actor, signed, now} Schedule{+beneficiary, mint, total, start, end, claimed}:
      authorize(Bool.and(signed, Sol.equal(actor, beneficiary)), claim(Schedule{beneficiary, mint, total, start, end, claimed}, now))

def live(context: Sol.Context, schedule: Schedule, instruction: Instruction) -> Outcome:
  match instruction:
    case Initialize{beneficiary, mint, total, start, end}:
      Rejected{7}
    case Claim{}:
      live_claim(context, schedule)

def initialize_instruction(signed: Bool, instruction: Instruction) -> Outcome:
  match instruction:
    case Claim{}:
      Rejected{2}
    case Initialize{beneficiary, mint, +total, +start, +end}:
      authorize(signed, initialize(Bool.and(Math.less(start, end), Bool.not(Math.equal(total, Math.zero()))), beneficiary, mint, total, start, end))

def empty(context: Sol.Context, instruction: Instruction) -> Outcome:
  match context:
    case Sol.Context{actor, signed, now}:
      initialize_instruction(signed, instruction)

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match state:
    case Live{schedule}:
      live(context, schedule, instruction)
    case Empty{}:
      empty(context, instruction)
