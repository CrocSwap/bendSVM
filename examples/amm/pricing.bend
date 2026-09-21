import ../../sdk/math.bend as Math
import ../../sdk/wide.bend as Wide

# Pure quotes. Token accounts, signatures and user limits belong in the pool
# transition. Checked errors: 1 overflow, 2 underflow, 3 division by zero,
# 4 economically invalid (zero reserve/input/effective input/output/shares).

def positive(+value: Math.U64) -> Bool:
  Bool.not(Math.equal(value, Math.zero()))

def positive_result(valid: Bool, amount: Math.U64) -> Math.Checked:
  match valid:
    case False{}:
      Math.Err{4}
    case True{}:
      Math.Ok{amount}

def require_positive(value: Math.Checked) -> Math.Checked:
  match value:
    case Math.Err{code}:
      Math.Err{code}
    case Math.Ok{+amount}:
      positive_result(positive(amount), amount)

# Fees remain in the pool. Rounding up charges at least one unit on any
# nonzero trade; trades too small to leave an effective input are rejected.
def fee(amount: Math.U64) -> Math.Checked:
  Wide.ceil(amount, Math.U64{30, 0}, Math.U64{10000, 0})

def output_with_denominator(reserve: Math.U64, effective: Math.U64, denominator: Math.Checked) -> Math.Checked:
  match denominator:
    case Math.Err{code}:
      Math.Err{code}
    case Math.Ok{total}:
      require_positive(Wide.floor(reserve, effective, total))

def output_with_effective(input: Math.U64, output: Math.U64, effective: Math.Checked) -> Math.Checked:
  match effective:
    case Math.Err{code}:
      Math.Err{code}
    case Math.Ok{+amount}:
      output_with_denominator(output, amount, Math.add(input, amount))

def output_with_fee(input: Math.U64, output: Math.U64, gross: Math.U64, charge: Math.Checked) -> Math.Checked:
  match charge:
    case Math.Err{code}:
      Math.Err{code}
    case Math.Ok{amount}:
      output_with_effective(input, output, require_positive(Math.sub(gross, amount)))

# Check the gross reserve addition as well as the pricing denominator: the
# actual transfer includes the fee and therefore requires more reserve space.
def output_with_capacity(input: Math.U64, output: Math.U64, +gross: Math.U64, capacity: Math.Checked) -> Math.Checked:
  match capacity:
    case Math.Err{code}:
      Math.Err{code}
    case Math.Ok{total}:
      output_with_fee(input, output, gross, fee(gross))

def swap_valid(valid: Bool, +input: Math.U64, output: Math.U64, +gross: Math.U64) -> Math.Checked:
  match valid:
    case False{}:
      Math.Err{4}
    case True{}:
      output_with_capacity(input, output, gross, Math.add(input, gross))

def swap(+input: Math.U64, +output: Math.U64, +gross: Math.U64) -> Math.Checked:
  swap_valid(Bool.and(positive(input), Bool.and(positive(output), positive(gross))), input, output, gross)

# Exact requested LP shares, with pool-favoring ceiling payments. The caller
# checks the resulting reserve and supply additions and the user's maxima.
def deposit_valid(valid: Bool, reserve: Math.U64, shares: Math.U64, supply: Math.U64) -> Math.Checked:
  match valid:
    case False{}:
      Math.Err{4}
    case True{}:
      require_positive(Wide.ceil(reserve, shares, supply))

def deposit(+reserve: Math.U64, +shares: Math.U64, +supply: Math.U64) -> Math.Checked:
  deposit_valid(Bool.and(positive(reserve), Bool.and(positive(shares), positive(supply))), reserve, shares, supply)

# Floor receipts. The pool transition additionally enforces locked liquidity,
# share ownership, and user minima before burning or transferring any tokens.
def withdraw_valid(valid: Bool, reserve: Math.U64, shares: Math.U64, supply: Math.U64) -> Math.Checked:
  match valid:
    case False{}:
      Math.Err{4}
    case True{}:
      require_positive(Wide.floor(reserve, shares, supply))

def withdraw(+reserve: Math.U64, +shares: Math.U64, +supply: Math.U64) -> Math.Checked:
  withdraw_valid(Bool.and(positive(reserve), Bool.and(positive(shares), Math.less(shares, supply))), reserve, shares, supply)
