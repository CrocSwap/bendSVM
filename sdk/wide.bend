import ./math.bend as Math

type U128 is Data:
  U128{low: Math.U64, high: Math.U64}

def add(a: U128, b: U128) -> U128:
  match a b:
    case U128{+al, ah} U128{bl, bh}:
      +low = Math.add_wrap(al, bl)
      U128{low, Math.add_wrap(Math.add_wrap(ah, bh), Math.U64{Bool.to_u32(Math.less(low, al)), 0})}

def product_parts(p0: Math.U64, p1: Math.U64, p2: Math.U64, p3: Math.U64) -> U128:
  match p1 p2:
    case Math.U64{l1, h1} Math.U64{l2, h2}:
      add(add(U128{p0, p3}, U128{Math.U64{0, l1}, Math.U64{h1, 0}}), U128{Math.U64{0, l2}, Math.U64{h2, 0}})

def product(a: Math.U64, b: Math.U64) -> U128:
  match a b:
    case Math.U64{+al, +ah} Math.U64{+bl, +bh}:
      product_parts(Math.mul32(al, bl), Math.mul32(al, bh), Math.mul32(ah, bl), Math.mul32(ah, bh))

# high >= divisor iff the quotient does not fit in 64 bits. When high is zero,
# the first 32 restoring steps can be skipped if low's high limb is below the
# divisor. The other fitting cases start with high as the initial remainder.
def divide_route(short: Bool, low: Math.U64, high: Math.U64, divisor: Math.U64) -> Math.DivResult:
  match short:
    case True{}:
      match low:
        case Math.U64{lo, hi}:
          Math.div_finish(Math.div32(Math.DivState{Math.U64{0, lo}, Math.U64{hi, 0}, divisor}))
    case False{}:
      Math.div_finish(Math.div64(Math.DivState{low, high, divisor}))

def divide_one(is_one: Bool, low: Math.U64, +high: Math.U64, +divisor: Math.U64) -> Math.DivResult:
  match is_one:
    case True{}:
      Math.DivOk{Math.Division{low, Math.zero()}}
    case False{}:
      match low divisor:
        case Math.U64{llo, +lhi} Math.U64{dlo, +dhi}:
          divide_route(Bool.and(Math.equal(high, Math.zero()), Bool.or(U32.is_zero(lhi), Bool.not(U32.is_zero(dhi)))), Math.U64{llo, lhi}, high, Math.U64{dlo, dhi})

def divide_fits(fits: Bool, low: Math.U64, high: Math.U64, +divisor: Math.U64) -> Math.DivResult:
  match fits:
    case False{}:
      Math.DivErr{1}
    case True{}:
      divide_one(Math.equal(divisor, Math.U64{1, 0}), low, high, divisor)

def divide_guard(is_zero: Bool, value: U128, +divisor: Math.U64) -> Math.DivResult:
  match is_zero:
    case True{}:
      Math.DivErr{3}
    case False{}:
      match value:
        case U128{low, +high}:
          divide_fits(Math.less(high, divisor), low, high, divisor)

def divide(value: U128, +divisor: Math.U64) -> Math.DivResult:
  divide_guard(Math.equal(divisor, Math.zero()), value, divisor)

def mul_div(a: Math.U64, b: Math.U64, divisor: Math.U64) -> Math.DivResult:
  divide(product(a, b), divisor)

def floor(a: Math.U64, b: Math.U64, divisor: Math.U64) -> Math.Checked:
  Math.quotient(mul_div(a, b, divisor))

def round_up(exact: Bool, quotient: Math.U64) -> Math.Checked:
  match exact:
    case True{}:
      Math.Ok{quotient}
    case False{}:
      Math.add(quotient, Math.U64{1, 0})

def ceil_result(result: Math.DivResult) -> Math.Checked:
  match result:
    case Math.DivErr{code}:
      Math.Err{code}
    case Math.DivOk{Math.Division{q, r}}:
      round_up(Math.equal(r, Math.zero()), q)

def ceil(a: Math.U64, b: Math.U64, divisor: Math.U64) -> Math.Checked:
  ceil_result(mul_div(a, b, divisor))
