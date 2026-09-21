import ../../sdk/context.bend as Sol
import ../../sdk/math.bend as Math
import ../../sdk/buffer.bend as B
import ../../sdk/fold.bend as F
import ../../sdk/effects.bend as Token
import ../../sdk/issuance.bend as Fx
import ../../sdk/effect-buffer.bend as EB

type Obligation is Data:
  Obligation{recipient: Sol.Key, amount: Math.U64}

type Batch is Data:
  Batch{owner: Sol.Key, mint: Sol.Key, vault: Sol.Key, obligations: B.Vector<Obligation, B.Pair<B.Pair<Obligation>>>, fuel: Nat, total: Math.U64}

type State is Data:
  Empty{}
  Funded{batch: Batch}
  Closed{}

type Instruction is Data:
  Initialize{mint: Sol.Key, vault: Sol.Key, obligations: B.Vector<Obligation, B.Pair<B.Pair<Obligation>>>, fuel: Nat}
  Settle{}

type Outcome is Data:
  Accepted{state: State, effects: B.Vector<Fx.Effect, B.Pair<B.Pair<Fx.Effect>>>}
  Rejected{code: U32}

def read(storage: B.Pair<B.Pair<Obligation>>, index: U32) -> Obligation:
  B.quad_get(Obligation, storage, index)

def overflow(result: Math.Checked) -> Math.Checked:
  match result:
    case Math.Err{code}:
      Math.Err{4}
    case Math.Ok{value}:
      Math.Ok{value}

def positive(valid: Bool, total: Math.U64, amount: Math.U64) -> Math.Checked:
  match valid:
    case False{}:
      Math.Err{3}
    case True{}:
      overflow(Math.add(total, amount))

def add_amount(total: Math.Checked, +amount: Math.U64) -> Math.Checked:
  match total:
    case Math.Err{code}:
      Math.Err{code}
    case Math.Ok{value}:
      positive(Bool.not(Math.equal(amount, Math.zero())), value, amount)

def sum_step(total: Math.Checked, obligation: Obligation) -> B.Result<Math.Checked>:
  match obligation:
    case Obligation{recipient, amount}:
      B.Valid{add_amount(total, amount)}

def sum(fuel: Nat, obligations: B.Vector<Obligation, B.Pair<B.Pair<Obligation>>>) -> B.Result<Math.Checked>:
  F.fold(Obligation, B.Pair<B.Pair<Obligation>>, Math.Checked, 4, read, sum_step, fuel, obligations, Math.Ok{Math.zero()})

def fund(nonzero: Bool, batch: Batch, +total: Math.U64) -> Outcome:
  match nonzero batch:
    case False{} Batch{owner, mint, vault, obligations, fuel, previous}:
      Rejected{3}
    case True{} Batch{owner, +mint, +vault, obligations, fuel, previous}:
      Accepted{Funded{Batch{owner, mint, vault, obligations, fuel, total}}, EB.one(
        Fx.BoundTransfer{Fx.TransferDetails{4, 5, 6, mint, Token.ToCustody{}, total, Token.Actor{}},
          Fx.Any{}, Fx.Exact{vault}, False{}})}

def initialize_total(batch: Batch, result: Math.Checked) -> Outcome:
  match result:
    case Math.Err{code}:
      Rejected{code}
    case Math.Ok{+total}:
      fund(Bool.not(Math.equal(total, Math.zero())), batch, total)

def initialize_fold(batch: Batch, result: B.Result<Math.Checked>) -> Outcome:
  match result:
    case B.Invalid{}:
      Rejected{3}
    case B.Valid{total}:
      initialize_total(batch, total)

def initialize(signed: Bool, owner: Sol.Key, mint: Sol.Key, vault: Sol.Key, +obligations: B.Vector<Obligation, B.Pair<B.Pair<Obligation>>>, +fuel: Nat) -> Outcome:
  match signed:
    case False{}:
      Rejected{1}
    case True{}:
      initialize_fold(Batch{owner, mint, vault, obligations, fuel, Math.zero()}, sum(fuel, obligations))

type Plan is Data:
  Plan{mint: Sol.Key, vault: Sol.Key, total: Math.Checked, effects: B.Vector<Fx.Effect, B.Pair<B.Pair<Fx.Effect>>>}

def append(mint: Sol.Key, vault: Sol.Key, recipient: Sol.Key, amount: Math.U64, effects: B.Vector<Fx.Effect, B.Pair<B.Pair<Fx.Effect>>>) -> B.Result<B.Vector<Fx.Effect, B.Pair<B.Pair<Fx.Effect>>>>:
  match effects:
    case B.Vector{+length, storage}:
      EB.push(B.Vector{length, storage}, Fx.BoundTransfer{
        Fx.TransferDetails{4, U32.add(6, length), 5, mint, Token.ToOwner{recipient}, amount, Token.Custody{}},
        Fx.Exact{vault}, Fx.Any{}, False{}})

def planned(mint: Sol.Key, vault: Sol.Key, total: Math.Checked, effects: B.Result<B.Vector<Fx.Effect, B.Pair<B.Pair<Fx.Effect>>>>) -> B.Result<Plan>:
  match effects:
    case B.Invalid{}:
      B.Invalid{}
    case B.Valid{value}:
      B.Valid{Plan{mint, vault, total, value}}

def settle_step(plan: Plan, obligation: Obligation) -> B.Result<Plan>:
  match plan obligation:
    case Plan{+mint, +vault, total, effects} Obligation{recipient, +amount}:
      planned(mint, vault, add_amount(total, amount), append(mint, vault, recipient, amount, effects))

def conserved(valid: Bool, effects: B.Vector<Fx.Effect, B.Pair<B.Pair<Fx.Effect>>>) -> Outcome:
  match valid:
    case False{}:
      Rejected{6}
    case True{}:
      Accepted{Closed{}, effects}

def settle_total(expected: Math.U64, total: Math.Checked, effects: B.Vector<Fx.Effect, B.Pair<B.Pair<Fx.Effect>>>) -> Outcome:
  match total:
    case Math.Err{code}:
      Rejected{code}
    case Math.Ok{+value}:
      conserved(Bool.and(Bool.not(Math.equal(value, Math.zero())), Math.equal(value, expected)), effects)

def settle_fold(expected: Math.U64, result: B.Result<Plan>) -> Outcome:
  match result:
    case B.Invalid{}:
      Rejected{5}
    case B.Valid{Plan{mint, vault, total, effects}}:
      settle_total(expected, total, effects)

def settle(allowed: Bool, batch: Batch) -> Outcome:
  match allowed batch:
    case False{} Batch{owner, mint, vault, obligations, fuel, total}:
      Rejected{1}
    case True{} Batch{owner, mint, vault, obligations, fuel, total}:
      settle_fold(total, F.fold(Obligation, B.Pair<B.Pair<Obligation>>, Plan, 4, read, settle_step,
        fuel, obligations, Plan{mint, vault, Math.Ok{Math.zero()}, EB.empty()}))

def active(context: Sol.Context, batch: Batch, instruction: Instruction) -> Outcome:
  match context batch instruction:
    case Sol.Context{actor, signed, slot} Batch{+owner, mint, vault, obligations, fuel, total} Settle{}:
      settle(Bool.and(signed, Sol.equal(actor, owner)), Batch{owner, mint, vault, obligations, fuel, total})
    case context batch Initialize{mint, vault, obligations, fuel}:
      Rejected{2}

def create(context: Sol.Context, instruction: Instruction) -> Outcome:
  match context instruction:
    case Sol.Context{actor, signed, slot} Initialize{mint, vault, obligations, fuel}:
      initialize(signed, actor, mint, vault, obligations, fuel)
    case context Settle{}:
      Rejected{2}

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match state:
    case Empty{}:
      create(context, instruction)
    case Funded{batch}:
      active(context, batch, instruction)
    case Closed{}:
      Rejected{2}
