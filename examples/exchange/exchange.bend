import ../../sdk/context.bend as Sol
import ../../sdk/math.bend as Math
import ../../sdk/wide.bend as Wide
import ../../sdk/effects.bend as Fx

type Offer is Data:
  Offer{maker: Sol.Key, base: Sol.Key, quote: Sol.Key, remaining: Math.U64, numerator: Math.U64, denominator: Math.U64}

type State is Data:
  Empty{}
  Open{offer: Offer}
  Closed{}

type Instruction is Data:
  Initialize{base: Sol.Key, quote: Sol.Key, amount: Math.U64, numerator: Math.U64, denominator: Math.U64}
  Fill{amount: Math.U64, max_payment: Math.U64}
  Cancel{}

type Outcome is Data:
  Accepted{state: State, effects: Fx.Effects}
  Rejected{code: U32}

def authorize(allowed: Bool, outcome: Outcome) -> Outcome:
  match allowed:
    case False{}:
      Rejected{1}
    case True{}:
      outcome

def initialize(valid: Bool, maker: Sol.Key, +base: Sol.Key, +quote: Sol.Key, +amount: Math.U64, numerator: Math.U64, denominator: Math.U64) -> Outcome:
  match valid:
    case False{}:
      Rejected{3}
    case True{}:
      Accepted{Open{Offer{maker, base, quote, amount, numerator, denominator}}, Fx.Effects{
        Fx.Transfer{4, 5, 6, base, Fx.ToCustody{}, amount, Fx.Actor{}},
        Fx.CheckMint{7, quote}}}

def quote_price(amount: Math.U64, numerator: Math.U64, denominator: Math.U64) -> Math.Checked:
  Wide.ceil(amount, numerator, denominator)

def next_state(empty: Bool, offer: Offer) -> State:
  match empty:
    case True{}:
      Closed{}
    case False{}:
      Open{offer}

def settle(offer: Offer, +amount: Math.U64, payment: Math.U64) -> Outcome:
  match offer:
    case Offer{+maker, +base, +quote, remaining, numerator, denominator}:
      +left = Math.sub_wrap(remaining, amount)
      Accepted{next_state(Math.equal(left, Math.zero()), Offer{maker, base, quote, left, numerator, denominator}), Fx.Effects{
        Fx.Transfer{4, 5, 6, quote, Fx.ToOwner{maker}, payment, Fx.Actor{}},
        Fx.Transfer{7, 8, 9, base, Fx.ToActor{}, amount, Fx.Custody{}}}}

def slippage(allowed: Bool, offer: Offer, amount: Math.U64, payment: Math.U64) -> Outcome:
  match allowed:
    case False{}:
      Rejected{5}
    case True{}:
      settle(offer, amount, payment)

def priced(offer: Offer, amount: Math.U64, max_payment: Math.U64, price: Math.Checked) -> Outcome:
  match price:
    case Math.Err{code}:
      Rejected{6}
    case Math.Ok{+payment}:
      slippage(Bool.and(Bool.not(Math.less(max_payment, payment)), Bool.not(Math.equal(payment, Math.zero()))), offer, amount, payment)

def fill_price(offer: Offer, +amount: Math.U64, max_payment: Math.U64) -> Outcome:
  match offer:
    case Offer{maker, base, quote, remaining, +numerator, +denominator}:
      priced(Offer{maker, base, quote, remaining, numerator, denominator}, amount, max_payment, quote_price(amount, numerator, denominator))

def fill_valid(valid: Bool, offer: Offer, amount: Math.U64, max_payment: Math.U64) -> Outcome:
  match valid:
    case False{}:
      Rejected{4}
    case True{}:
      fill_price(offer, amount, max_payment)

def fill(offer: Offer, +amount: Math.U64, max_payment: Math.U64) -> Outcome:
  match offer:
    case Offer{maker, base, quote, +remaining, numerator, denominator}:
      fill_valid(Bool.and(Bool.not(Math.equal(amount, Math.zero())), Bool.not(Math.less(remaining, amount))),
        Offer{maker, base, quote, remaining, numerator, denominator}, amount, max_payment)

def cancel(offer: Offer) -> Outcome:
  match offer:
    case Offer{maker, base, quote, remaining, numerator, denominator}:
      Accepted{Closed{}, Fx.one(Fx.Transfer{4, 5, 6, base, Fx.ToActor{}, remaining, Fx.Custody{}})}

def cancel_authorized(context: Sol.Context, offer: Offer) -> Outcome:
  match context offer:
    case Sol.Context{actor, signed, slot} Offer{+maker, base, quote, remaining, numerator, denominator}:
      authorize(Bool.and(signed, Sol.equal(actor, maker)), cancel(Offer{maker, base, quote, remaining, numerator, denominator}))

def fill_authorized(context: Sol.Context, offer: Offer, amount: Math.U64, max_payment: Math.U64) -> Outcome:
  match context:
    case Sol.Context{actor, signed, slot}:
      authorize(signed, fill(offer, amount, max_payment))

def active(context: Sol.Context, offer: Offer, instruction: Instruction) -> Outcome:
  match instruction:
    case Initialize{base, quote, amount, numerator, denominator}:
      Rejected{8}
    case Fill{amount, max_payment}:
      fill_authorized(context, offer, amount, max_payment)
    case Cancel{}:
      cancel_authorized(context, offer)

def create_instruction(actor: Sol.Key, signed: Bool, instruction: Instruction) -> Outcome:
  match instruction:
    case Initialize{+base, +quote, +amount, +numerator, +denominator}:
      authorize(signed, initialize(Bool.and(Bool.not(Sol.equal(base, quote)), Bool.and(Bool.not(Math.equal(amount, Math.zero())),
        Bool.and(Bool.not(Math.equal(numerator, Math.zero())), Bool.not(Math.equal(denominator, Math.zero()))))), actor, base, quote, amount, numerator, denominator))
    case Fill{amount, max_payment}:
      Rejected{2}
    case Cancel{}:
      Rejected{2}

def empty(context: Sol.Context, instruction: Instruction) -> Outcome:
  match context:
    case Sol.Context{actor, signed, slot}:
      create_instruction(actor, signed, instruction)

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match state:
    case Empty{}:
      empty(context, instruction)
    case Open{offer}:
      active(context, offer, instruction)
    case Closed{}:
      Rejected{7}
