import ../../sdk/context.bend as Sol
import ../../sdk/math.bend as Math
import ../../sdk/sqrt.bend as Sqrt
import ../../sdk/effects.bend as Fx
import ../../sdk/issuance.bend as Token
import ./pricing.bend as Price

# Fixed account order: state, actor, token program, custody,
# user base, base reserve, base mint, user quote, quote reserve, quote mint,
# user LP, LP mint. Configuration is immutable after creation.
type Config is Data:
  Config{base: Sol.Key, quote: Sol.Key, lp: Sol.Key, base_vault: Sol.Key, quote_vault: Sol.Key}

type Balances is Data:
  Balances{base: Math.U64, quote: Math.U64, shares: Math.U64}

type Pool is Data:
  Pool{config: Config, balances: Balances}

type State is Data:
  Empty{}
  Open{pool: Pool}

type Instruction is Data:
  Initialize{config: Config, base: Math.U64, quote: Math.U64, min_shares: Math.U64}
  Deposit{shares: Math.U64, max_base: Math.U64, max_quote: Math.U64}
  Withdraw{shares: Math.U64, min_base: Math.U64, min_quote: Math.U64}
  Swap{base_in: Bool, amount: Math.U64, min_output: Math.U64}

type Outcome is Data:
  Accepted{state: State, effects: Token.Effects}
  Rejected{code: U32}

# Errors: 1 unsigned, 2 wrong lifecycle, 3 invalid configuration,
# 4 arithmetic/zero amount, 5 user limit, 6 locked liquidity.
def locked() -> Math.U64:
  Math.U64{1000, 0}

def at_least(a: Math.U64, b: Math.U64) -> Bool:
  Bool.not(Math.less(a, b))

def guard(valid: Bool, code: U32, outcome: Outcome) -> Outcome:
  match valid:
    case False{}:
      Rejected{code}
    case True{}:
      outcome

# A pair of reserve movements uses exact reserve addresses. User token
# accounts may be any accounts for the expected mint owned by the signer.
def base_in(config: Config, amount: Math.U64, fresh: Bool) -> Token.Effect:
  match config:
    case Config{base, quote, lp, vault, other}:
      Token.BoundTransfer{Token.TransferDetails{4, 5, 6, base, Fx.ToCustody{}, amount, Fx.Actor{}}, Token.Any{}, Token.Exact{vault}, fresh}

def quote_in(config: Config, amount: Math.U64, fresh: Bool) -> Token.Effect:
  match config:
    case Config{base, quote, lp, other, vault}:
      Token.BoundTransfer{Token.TransferDetails{7, 8, 9, quote, Fx.ToCustody{}, amount, Fx.Actor{}}, Token.Any{}, Token.Exact{vault}, fresh}

def base_out(config: Config, amount: Math.U64) -> Token.Effect:
  match config:
    case Config{base, quote, lp, vault, other}:
      Token.BoundTransfer{Token.TransferDetails{5, 4, 6, base, Fx.ToActor{}, amount, Fx.Custody{}}, Token.Exact{vault}, Token.Any{}, False{}}

def quote_out(config: Config, amount: Math.U64) -> Token.Effect:
  match config:
    case Config{base, quote, lp, other, vault}:
      Token.BoundTransfer{Token.TransferDetails{8, 7, 9, quote, Fx.ToActor{}, amount, Fx.Custody{}}, Token.Exact{vault}, Token.Any{}, False{}}

def mint(config: Config, amount: Math.U64, fresh: Bool) -> Token.Effect:
  match config:
    case Config{base, quote, lp, left, right}:
      Token.Mint{10, 11, lp, Fx.ToActor{}, amount, fresh}

def burn(config: Config, amount: Math.U64) -> Token.Effect:
  match config:
    case Config{base, quote, lp, left, right}:
      Token.Burn{10, 11, lp, amount}

def funding(+config: Config, base: Math.U64, quote: Math.U64, shares: Math.U64, +fresh: Bool) -> Token.Effects:
  Token.Effects{base_in(config, base, fresh), quote_in(config, quote, fresh), mint(config, shares, fresh)}

def redemption(+config: Config, base: Math.U64, quote: Math.U64, shares: Math.U64) -> Token.Effects:
  Token.Effects{burn(config, shares), base_out(config, base), quote_out(config, quote)}

# All accounting additions/subtractions must succeed before accepting effects.
def finish(config: Config, base: Math.Checked, quote: Math.Checked, shares: Math.Checked, effects: Token.Effects) -> Outcome:
  match base quote shares:
    case Math.Ok{x} Math.Ok{y} Math.Ok{s}:
      Accepted{Open{Pool{config, Balances{x, y, s}}}, effects}
    case x y s:
      Rejected{4}

def valid_config(config: Config) -> Bool:
  match config:
    case Config{+base, +quote, +lp, left, right}:
      Bool.and(Bool.not(Sol.equal(base, quote)), Bool.and(Bool.not(Sol.equal(base, lp)),
        Bool.and(Bool.not(Sol.equal(quote, lp)), Bool.not(Sol.equal(left, right)))))

def initialized(+config: Config, +base: Math.U64, +quote: Math.U64, minimum: Math.U64, +total: Math.U64, issued: Math.Checked) -> Outcome:
  match issued:
    case Math.Err{code}:
      Rejected{4}
    case Math.Ok{+shares}:
      guard(at_least(shares, minimum), 5,
        Accepted{Open{Pool{config, Balances{base, quote, total}}}, funding(config, base, quote, shares, True{})})

def initial_supply(config: Config, base: Math.U64, quote: Math.U64, minimum: Math.U64, +total: Math.U64) -> Outcome:
  initialized(config, base, quote, minimum, total, Price.require_positive(Math.sub(total, locked())))

def initialize_valid(valid: Bool, config: Config, +base: Math.U64, +quote: Math.U64, minimum: Math.U64) -> Outcome:
  match valid:
    case False{}:
      Rejected{3}
    case True{}:
      initial_supply(config, base, quote, minimum, Sqrt.geometric_mean(base, quote))

def initialize(+config: Config, +base: Math.U64, +quote: Math.U64, minimum: Math.U64) -> Outcome:
  initialize_valid(Bool.and(valid_config(config), Bool.and(Price.positive(base), Price.positive(quote))), config, base, quote, minimum)

# Deposits request exact LP shares; both payments round up.
def deposit_payments(pool: Pool, +shares: Math.U64, max_base: Math.U64, max_quote: Math.U64, base: Math.Checked, quote: Math.Checked) -> Outcome:
  match pool base quote:
    case Pool{+config, Balances{x, y, supply}} Math.Ok{+dx} Math.Ok{+dy}:
      guard(Bool.and(at_least(max_base, dx), at_least(max_quote, dy)), 5,
        finish(config, Math.add(x, dx), Math.add(y, dy), Math.add(supply, shares), funding(config, dx, dy, shares, False{})))
    case pool base quote:
      Rejected{4}

def deposit(pool: Pool, +shares: Math.U64, max_base: Math.U64, max_quote: Math.U64) -> Outcome:
  match pool:
    case Pool{config, Balances{+x, +y, +supply}}:
      deposit_payments(Pool{config, Balances{x, y, supply}}, shares, max_base, max_quote,
        Price.deposit(x, shares, supply), Price.deposit(y, shares, supply))

# Burn before reserve withdrawals. A later token failure undoes the burn.
def withdraw_payments(pool: Pool, +shares: Math.U64, min_base: Math.U64, min_quote: Math.U64, base: Math.Checked, quote: Math.Checked) -> Outcome:
  match pool base quote:
    case Pool{+config, Balances{x, y, supply}} Math.Ok{+dx} Math.Ok{+dy}:
      guard(Bool.and(at_least(dx, min_base), at_least(dy, min_quote)), 5,
        finish(config, Math.sub(x, dx), Math.sub(y, dy), Math.sub(supply, shares), redemption(config, dx, dy, shares)))
    case pool base quote:
      Rejected{4}

def withdraw_valid(valid: Bool, pool: Pool, +shares: Math.U64, min_base: Math.U64, min_quote: Math.U64) -> Outcome:
  match valid:
    case False{}:
      Rejected{6}
    case True{}:
      match pool:
        case Pool{config, Balances{+x, +y, +supply}}:
          withdraw_payments(Pool{config, Balances{x, y, supply}}, shares, min_base, min_quote,
            Price.withdraw(x, shares, supply), Price.withdraw(y, shares, supply))

def withdraw_available(pool: Pool, +shares: Math.U64, min_base: Math.U64, min_quote: Math.U64, available: Math.Checked) -> Outcome:
  match available:
    case Math.Err{code}:
      Rejected{6}
    case Math.Ok{amount}:
      withdraw_valid(Bool.and(Price.positive(shares), at_least(amount, shares)), pool, shares, min_base, min_quote)

def withdraw(pool: Pool, shares: Math.U64, min_base: Math.U64, min_quote: Math.U64) -> Outcome:
  match pool:
    case Pool{config, Balances{x, y, +supply}}:
      withdraw_available(Pool{config, Balances{x, y, supply}}, shares, min_base, min_quote, Math.sub(supply, locked()))

# Fees remain in reserves: the new input reserve credits gross, not effective.
def swap_settle(direction: Bool, pool: Pool, +gross: Math.U64, +output: Math.U64) -> Outcome:
  match direction pool:
    case True{} Pool{+config, Balances{x, y, supply}}:
      finish(config, Math.add(x, gross), Math.sub(y, output), Math.Ok{supply},
        Token.Effects{base_in(config, gross, False{}), quote_out(config, output), Token.None{}})
    case False{} Pool{+config, Balances{x, y, supply}}:
      finish(config, Math.sub(x, output), Math.add(y, gross), Math.Ok{supply},
        Token.Effects{quote_in(config, gross, False{}), base_out(config, output), Token.None{}})

def swap_priced(direction: Bool, pool: Pool, gross: Math.U64, minimum: Math.U64, result: Math.Checked) -> Outcome:
  match result:
    case Math.Err{code}:
      Rejected{4}
    case Math.Ok{+output}:
      guard(at_least(output, minimum), 5, swap_settle(direction, pool, gross, output))

def swap(direction: Bool, pool: Pool, +gross: Math.U64, minimum: Math.U64) -> Outcome:
  match direction pool:
    case True{} Pool{config, Balances{+x, +y, supply}}:
      swap_priced(True{}, Pool{config, Balances{x, y, supply}}, gross, minimum, Price.swap(x, y, gross))
    case False{} Pool{config, Balances{+x, +y, supply}}:
      swap_priced(False{}, Pool{config, Balances{x, y, supply}}, gross, minimum, Price.swap(y, x, gross))

def dispatch(state: State, instruction: Instruction) -> Outcome:
  match state instruction:
    case Empty{} Initialize{config, base, quote, minimum}:
      initialize(config, base, quote, minimum)
    case Open{pool} Deposit{shares, max_base, max_quote}:
      deposit(pool, shares, max_base, max_quote)
    case Open{pool} Withdraw{shares, min_base, min_quote}:
      withdraw(pool, shares, min_base, min_quote)
    case Open{pool} Swap{direction, amount, minimum}:
      swap(direction, pool, amount, minimum)
    case state instruction:
      Rejected{2}

def signed(signed: Bool, state: State, instruction: Instruction) -> Outcome:
  match signed:
    case False{}:
      Rejected{1}
    case True{}:
      dispatch(state, instruction)

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match context:
    case Sol.Context{actor, signature, slot}:
      signed(signature, state, instruction)
