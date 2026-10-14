import Base
import ../sdk/math.bend as Math
import ../sdk/wide.bend as Wide
import ../sdk/sqrt.bend as Sqrt
import ../sdk/buffer.bend as B

# A bounded row of signed two's-complement i64 cells. The gain is shared by
# the row; the numeric operations follow basanos's integer RMSNorm kernel.
type Row is Data:
  Row{cells: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<Math.U64>>>>>>}

type SumResult is Data:
  SumResult{index: U32, sum: Math.U64, valid: Bool}

type Reply is Data:
  Reply{error: U32, checksum: Math.U64}

def get2(p: B.Pair<Math.U64>, index: U32) -> Math.U64:
  B.pair_get(Math.U64, p, U32.and(index, 1))

def get4(p: B.Pair<B.Pair<Math.U64>>, +index: U32) -> Math.U64:
  get2(B.pair_get(B.Pair<Math.U64>, p, U32.and(U32.div(index, 2), 1)), index)

def get8(p: B.Pair<B.Pair<B.Pair<Math.U64>>>, +index: U32) -> Math.U64:
  get4(B.pair_get(B.Pair<B.Pair<Math.U64>>, p, U32.and(U32.div(index, 4), 1)), index)

def get16(p: B.Pair<B.Pair<B.Pair<B.Pair<Math.U64>>>>, +index: U32) -> Math.U64:
  get8(B.pair_get(B.Pair<B.Pair<B.Pair<Math.U64>>>, p, U32.and(U32.div(index, 8), 1)), index)

def get32(p: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<Math.U64>>>>>, +index: U32) -> Math.U64:
  get16(B.pair_get(B.Pair<B.Pair<B.Pair<B.Pair<Math.U64>>>>, p, U32.and(U32.div(index, 16), 1)), index)

def get64(row: Row, +index: U32) -> Math.U64:
  match row:
    case Row{cells}:
      get32(B.pair_get(B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<Math.U64>>>>>, cells, U32.and(U32.div(index, 32), 1)), index)

def negative(value: Math.U64) -> Bool:
  match value:
    case Math.U64{lo, hi}:
      U32.is_ge(hi, 2147483648)

def magnitude_choose(is_negative: Bool, value: Math.U64) -> Math.U64:
  match is_negative:
    case True{}:
      Math.sub_wrap(Math.zero(), value)
    case False{}:
      value

def magnitude(+value: Math.U64) -> Math.U64:
  magnitude_choose(negative(value), value)

def quotient(result: Math.DivResult) -> Math.U64:
  match result:
    case Math.DivOk{Math.Division{quotient, remainder}}:
      quotient
    case Math.DivErr{code}:
      Math.zero()

def square_absolute(absolute: Math.U64) -> Math.U64:
  match absolute:
    case Math.U64{+lo, hi}:
      Math.mul32(lo, lo)

def square(value: Math.U64) -> Math.U64:
  square_absolute(magnitude(value))

def bounded(value: Math.U64) -> Bool:
  Math.less(magnitude(value), Math.U64{67108864, 0})

def sum_loop(fuel: Nat, +row: Row, +index: U32, sum: Math.U64, valid: Bool) -> SumResult:
  match fuel:
    case Zero{}:
      SumResult{index, sum, valid}
    case Succ{pred}:
      sum_loop(pred, row, U32.add(index, 1),
        Math.add_wrap(sum, square(get64(row, index))),
        Bool.and(valid, bounded(get64(row, index))))

# For d>0, basanos rdiv(n,d) = floor((2n+d)/(2d)). Negative inputs use
# floor((-2|n|+d)/(2d)) = -floor((2|n|+d-1)/(2d)).
def round_num(+absolute: Math.U64, +divisor: Math.U64, one: Math.U64) -> Math.U64:
  +twice = Math.add_wrap(absolute, absolute)
  +biased = Math.add_wrap(twice, divisor)
  quotient(Math.divmod(Math.sub_wrap(biased, one), Math.add_wrap(divisor, divisor)))

def rounded_positive(absolute: Math.U64, divisor: Math.U64, neg: Bool) -> Math.U64:
  match neg:
    case True{}:
      round_num(absolute, divisor, Math.U64{1, 0})
    case False{}:
      round_num(absolute, divisor, Math.zero())

def signed(absolute: Math.U64, neg: Bool) -> Math.U64:
  match neg:
    case True{}:
      Math.sub_wrap(Math.zero(), absolute)
    case False{}:
      absolute

def shift12_bits(value: Math.U64) -> Math.U64:
  match value:
    case Math.U64{lo, +hi}:
      Math.U64{U32.or(U32.div(lo, 4096), U32.mul(U32.and(hi, 4095), 1048576)),
        U32.div(hi, 4096)}

def shift12_bias(value: Math.U64, bias: U32) -> Math.U64:
  shift12_bits(Math.add_wrap(value, Math.U64{bias, 0}))

def requant(value: Math.U64, neg: Bool) -> Math.U64:
  match neg:
    case True{}:
      shift12_bias(value, 2047)
    case False{}:
      shift12_bias(value, 2048)

def norm_quotient(gain: U32, +neg: Bool, q: Math.U64) -> Math.U64:
  match q:
    case Math.U64{ql, qh}:
      product = Math.mul32(ql, gain)
      rounded = requant(product, neg)
      signed(rounded, neg)

def norm_abs(root: Math.U64, gain: U32, +neg: Bool, absolute: Math.U64) -> Math.U64:
  match absolute:
    case Math.U64{lo, hi}:
      scaled = Math.mul32(lo, 4194304)
      norm_quotient(gain, neg, rounded_positive(scaled, root, neg))

def norm_value(root: Math.U64, gain: U32, +value: Math.U64) -> Math.U64:
  norm_abs(root, gain, negative(value), magnitude(value))

def norm_loop(fuel: Nat, +row: Row, +index: U32, +root: Math.U64,
    +gain: U32, checksum: Math.U64) -> Math.U64:
  match fuel:
    case Zero{}:
      checksum
    case Succ{pred}:
      norm_loop(pred, row, U32.add(index, 1), root, gain,
        Math.add_wrap(checksum, norm_value(root, gain, get64(row, index))))

def finish_allowed(allowed: Bool, row: Row, index: U32, sum: Math.U64,
    gain: U32, fuel: Nat) -> Reply:
  match allowed:
    case False{}:
      Reply{1, Math.zero()}
    case True{}:
      mean = quotient(Math.divmod(sum, Math.U64{index, 0}))
      root = Sqrt.floor(Wide.product(Math.add_wrap(mean, Math.U64{17, 0}), Math.U64{1048576, 0}))
      Reply{0, norm_loop(fuel, row, 0, root, gain, Math.zero())}

def finish_sum(state: SumResult, +gain: U32, fuel: Nat, row: Row) -> Reply:
  match state:
    case SumResult{+index, sum, valid}:
      finish_allowed(Bool.and(valid, Bool.and(Bool.not(U32.is_zero(index)), U32.is_le(gain, 65535))),
        row, index, sum, gain, fuel)

def normalize(+fuel: Nat, +row: Row, gain: U32) -> Reply:
  finish_sum(sum_loop(fuel, row, 0, Math.zero(), True{}), gain, fuel, row)
