import ../../sdk/context.bend as Sol
import ../../sdk/collection.bend as C
import ../../sdk/math.bend as M
import ../../sdk/buffer.bend as B
import ../../sdk/fold.bend as F
import ../../sdk/effects.bend as Token
import ../../sdk/issuance.bend as Fx

type Obligation is Data:
  Obligation{recipient: Sol.Key, amount: M.U64}

type Queue is Data:
  Queue{owner: Sol.Key, mint: Sol.Key, vault: Sol.Key, collection: Sol.Key, count: U32, cursor: U32, remaining: M.U64}

type State is Data:
  Empty{}
  Collecting{queue: Queue}
  Paying{queue: Queue}
  Closed{}

type Instruction is Data:
  Initialize{mint: Sol.Key, vault: Sol.Key}
  Append{recipient: Sol.Key, amount: M.U64}
  Seal{}
  Settle{count: U32, fuel: Nat}

type Outcome is Data:
  Accepted{state: State, window: C.Window<Obligation, B.Pair<Obligation>>, length: U32, effects: B.Vector<Fx.Effect, B.Pair<Fx.Effect>>}
  Rejected{code: U32}

def none() -> B.Vector<Fx.Effect, B.Pair<Fx.Effect>>:
  B.Vector{0, B.Pair{Fx.None{}, Fx.None{}}}

def one(effect: Fx.Effect) -> B.Vector<Fx.Effect, B.Pair<Fx.Effect>>:
  B.Vector{1, B.Pair{effect, Fx.None{}}}

def read(storage: B.Pair<Obligation>, index: U32) -> Obligation:
  B.pair_get(Obligation, storage, index)

def write(storage: B.Pair<Obligation>, index: U32, value: Obligation) -> B.Pair<Obligation>:
  B.pair_set(Obligation, storage, index, value)

def write_effect(storage: B.Pair<Fx.Effect>, index: U32, value: Fx.Effect) -> B.Pair<Fx.Effect>:
  B.pair_set(Fx.Effect, storage, index, value)

def position(state: State) -> U32:
  match state:
    case Paying{Queue{owner, mint, vault, collection, count, cursor, remaining}}:
      cursor
    case Empty{}:
      0
    case Collecting{queue}:
      0
    case Closed{}:
      0

def select(context: C.Context, state: State, instruction: Instruction, +metadata: C.Metadata) -> B.Result<C.Range>:
  match instruction:
    case Append{recipient, amount}:
      match metadata:
        case C.Metadata{length, capacity}:
          C.reserve_range(metadata, length, 1, 2)
    case Settle{count, fuel}:
      C.read_range(metadata, position(state), count, 2)
    case Initialize{mint, vault}:
      C.read_range(metadata, 0, 0, 2)
    case Seal{}:
      C.read_range(metadata, 0, 0, 2)

def allowed(context: C.Context, queue: Queue) -> Bool:
  match context queue:
    case C.Context{actor, signed, slot, actual} Queue{owner, mint, vault, collection, count, cursor, remaining}:
      Bool.and(signed, Bool.and(Sol.equal(actor, owner), Sol.equal(actual, collection)))

def initialized(valid: Bool, owner: Sol.Key, mint: Sol.Key, vault: Sol.Key, collection: Sol.Key, window: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match valid:
    case False{}:
      Rejected{1}
    case True{}:
      Accepted{Collecting{Queue{owner, mint, vault, collection, 0, 0, M.zero()}}, window, 0, none()}

def create_initialized(context: C.Context, metadata: C.Metadata, mint: Sol.Key, vault: Sol.Key, window: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match context metadata:
    case C.Context{owner, signed, slot, collection} C.Metadata{length, capacity}:
      initialized(Bool.and(signed, U32.is_zero(length)), owner, mint, vault, collection, window)

def create(context: C.Context, instruction: Instruction, +metadata: C.Metadata, window: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match instruction:
    case Initialize{mint, vault}:
      create_initialized(context, metadata, mint, vault, window)
    case Append{recipient, amount}:
      Rejected{2}
    case Seal{}:
      Rejected{2}
    case Settle{count, fuel}:
      Rejected{2}

def appended_value(queue: Queue, amount: M.U64, value: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match queue:
    case Queue{owner, +mint, +vault, collection, +count, cursor, remaining}:
      Accepted{Collecting{Queue{owner, mint, vault, collection, count, cursor, remaining}}, value, count,
        one(Fx.BoundTransfer{Fx.TransferDetails{5, 6, 7, mint, Token.ToCustody{}, amount, Token.Actor{}}, Fx.Any{}, Fx.Exact{vault}, False{}})}

def appended(queue: Queue, amount: M.U64, window: B.Result<C.Window<Obligation, B.Pair<Obligation>>>) -> Outcome:
  match window:
    case B.Invalid{}:
      Rejected{3}
    case B.Valid{value}:
      appended_value(queue, amount, value)

def append_ok(queue: Queue, obligation: Obligation, window: C.Window<Obligation, B.Pair<Obligation>>, total: M.U64) -> Outcome:
  match queue obligation:
    case Queue{owner, mint, vault, collection, count, cursor, remaining} Obligation{recipient, +amount}:
      appended(Queue{owner, mint, vault, collection, U32.add(count, 1), cursor, total}, amount,
        C.push(Obligation, B.Pair<Obligation>, 2, write, window, Obligation{recipient, amount}))

def append_total(queue: Queue, obligation: Obligation, window: C.Window<Obligation, B.Pair<Obligation>>, result: M.Checked) -> Outcome:
  match result:
    case M.Err{code}:
      Rejected{4}
    case M.Ok{total}:
      append_ok(queue, obligation, window, total)

def append_add(+queue: Queue, +obligation: Obligation, window: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match queue obligation:
    case Queue{owner, mint, vault, collection, count, cursor, remaining} Obligation{recipient, amount}:
      append_total(queue, obligation, window, M.add(remaining, amount))

def append_checked(valid: Bool, +queue: Queue, +obligation: Obligation, window: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match valid:
    case False{}:
      Rejected{3}
    case True{}:
      append_add(queue, obligation, window)

def append(queue: Queue, recipient: Sol.Key, +amount: M.U64, metadata: C.Metadata, +window: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match queue metadata window:
    case Queue{owner, mint, vault, collection, +count, cursor, remaining} C.Metadata{+length, capacity} C.Window{start, B.Vector{loaded, storage}}:
      append_checked(Bool.and(Bool.not(M.equal(amount, M.zero())),
        Bool.and(U32.is_eq(count, length), Bool.and(U32.is_lt(length, capacity),
          Bool.and(U32.is_eq(start, length), U32.is_zero(loaded))))),
        Queue{owner, mint, vault, collection, count, cursor, remaining}, Obligation{recipient, amount}, window)

def sealed(valid: Bool, queue: Queue, window: C.Window<Obligation, B.Pair<Obligation>>, length: U32) -> Outcome:
  match valid:
    case False{}:
      Rejected{3}
    case True{}:
      Accepted{Paying{queue}, window, length, none()}

def seal(queue: Queue, metadata: C.Metadata, window: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match queue metadata:
    case Queue{owner, mint, vault, collection, +count, cursor, remaining} C.Metadata{+length, capacity}:
      sealed(Bool.and(U32.is_eq(count, length), Bool.not(U32.is_zero(count))),
        Queue{owner, mint, vault, collection, count, cursor, remaining}, window, length)

def collecting(+queue: Queue, instruction: Instruction, +metadata: C.Metadata, window: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match instruction:
    case Append{recipient, amount}:
      append(queue, recipient, amount, metadata, window)
    case Seal{}:
      seal(queue, metadata, window)
    case Initialize{mint, vault}:
      Rejected{2}
    case Settle{count, fuel}:
      Rejected{2}

type Plan is Data:
  Plan{mint: Sol.Key, vault: Sol.Key, remaining: M.Checked, effects: B.Vector<Fx.Effect, B.Pair<Fx.Effect>>}

def deduct(amount: M.U64, result: M.Checked) -> M.Checked:
  match result:
    case M.Err{code}:
      M.Err{code}
    case M.Ok{remaining}:
      M.sub(remaining, amount)

def planned(mint: Sol.Key, vault: Sol.Key, remaining: M.Checked, effects: B.Result<B.Vector<Fx.Effect, B.Pair<Fx.Effect>>>) -> B.Result<Plan>:
  match effects:
    case B.Invalid{}:
      B.Invalid{}
    case B.Valid{value}:
      B.Valid{Plan{mint, vault, remaining, value}}

def step(plan: Plan, obligation: Obligation) -> B.Result<Plan>:
  match plan obligation:
    case Plan{+mint, +vault, remaining, B.Vector{+index, storage}} Obligation{recipient, +amount}:
      planned(mint, vault, deduct(amount, remaining), B.push(Fx.Effect, B.Pair<Fx.Effect>, 2, write_effect, B.Vector{index, storage},
        Fx.BoundTransfer{Fx.TransferDetails{5, U32.add(7, index), 6, mint, Token.ToOwner{recipient}, amount, Token.Custody{}}, Fx.Exact{vault}, Fx.Any{}, False{}}))

def finish_page(valid: Bool, state: State, window: C.Window<Obligation, B.Pair<Obligation>>, length: U32, effects: B.Vector<Fx.Effect, B.Pair<Fx.Effect>>) -> Outcome:
  match valid:
    case False{}:
      Rejected{6}
    case True{}:
      Accepted{state, window, length, effects}

def settled_value(queue: Queue, page: U32, window: C.Window<Obligation, B.Pair<Obligation>>, +value: M.U64, effects: B.Vector<Fx.Effect, B.Pair<Fx.Effect>>) -> Outcome:
  match queue:
    case Queue{owner, mint, vault, collection, +count, cursor, previous}:
      +next = U32.add(cursor, page)
      +last = U32.is_eq(next, count)
      finish_page(B.pick(Bool, M.equal(value, M.zero()), Bool.not(M.equal(value, M.zero())), last),
        B.pick(State, Closed{}, Paying{Queue{owner, mint, vault, collection, count, next, value}}, last), window, count, effects)

def settled(+queue: Queue, +page: U32, window: C.Window<Obligation, B.Pair<Obligation>>, remaining: M.Checked, effects: B.Vector<Fx.Effect, B.Pair<Fx.Effect>>) -> Outcome:
  match remaining:
    case M.Err{code}:
      Rejected{4}
    case M.Ok{value}:
      settled_value(queue, page, window, value, effects)

def folded(queue: Queue, page: U32, window: C.Window<Obligation, B.Pair<Obligation>>, result: B.Result<Plan>) -> Outcome:
  match result:
    case B.Invalid{}:
      Rejected{5}
    case B.Valid{Plan{mint, vault, remaining, effects}}:
      settled(queue, page, window, remaining, effects)

def run_fold(+queue: Queue, page: U32, fuel: Nat, +window: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match queue window:
    case Queue{owner, mint, vault, collection, count, cursor, remaining} C.Window{start, entries}:
      folded(queue, page, window, F.fold(Obligation, B.Pair<Obligation>, Plan, 2, read, step, fuel, entries, Plan{mint, vault, M.Ok{remaining}, none()}))

def settle_checked(valid: Bool, +queue: Queue, page: U32, fuel: Nat, +window: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match valid:
    case False{}:
      Rejected{3}
    case True{}:
      run_fold(queue, page, fuel, window)

def settle(queue: Queue, +page: U32, fuel: Nat, metadata: C.Metadata, +window: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match queue metadata window:
    case Queue{owner, mint, vault, collection, +count, +cursor, remaining} C.Metadata{length, capacity} C.Window{start, B.Vector{loaded, storage}}:
      settle_checked(Bool.and(U32.is_eq(count, length), Bool.and(U32.is_eq(start, cursor),
        Bool.and(U32.is_eq(loaded, page), Bool.and(Bool.not(U32.is_zero(page)),
          Bool.and(U32.is_ge(2, page), C.fits(cursor, page, count)))))),
        Queue{owner, mint, vault, collection, count, cursor, remaining}, page, fuel, window)

def paying(queue: Queue, instruction: Instruction, +metadata: C.Metadata, window: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match instruction:
    case Settle{count, fuel}:
      settle(queue, count, fuel, metadata, window)
    case Initialize{mint, vault}:
      Rejected{2}
    case Append{recipient, amount}:
      Rejected{2}
    case Seal{}:
      Rejected{2}

def phase(collecting_phase: Bool, queue: Queue, instruction: Instruction, metadata: C.Metadata, window: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match collecting_phase:
    case True{}:
      collecting(queue, instruction, metadata, window)
    case False{}:
      paying(queue, instruction, metadata, window)

def authorized(valid: Bool, +collecting_phase: Bool, queue: Queue, instruction: Instruction, metadata: C.Metadata, window: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match valid:
    case False{}:
      Rejected{1}
    case True{}:
      phase(collecting_phase, queue, instruction, metadata, window)

def process(+context: C.Context, state: State, instruction: Instruction, metadata: C.Metadata, window: C.Window<Obligation, B.Pair<Obligation>>) -> Outcome:
  match state:
    case Empty{}:
      create(context, instruction, metadata, window)
    case Collecting{+queue}:
      authorized(allowed(context, queue), True{}, queue, instruction, metadata, window)
    case Paying{+queue}:
      authorized(allowed(context, queue), False{}, queue, instruction, metadata, window)
    case Closed{}:
      Rejected{2}
