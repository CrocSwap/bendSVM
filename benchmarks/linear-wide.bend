import Base
import ../sdk/math.bend as Math
import ../sdk/buffer.bend as B
import ../sdk/zip-fold.bend as Z

# A bounded 32-term quantized linear row. q and w are signed i8 values encoded
# as bytes in U32 cells. The two rounding stages match basanos linear_row.
type Row is Data:
  Row{cells: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>>}

type SumResult is Data:
  SumResult{index: U32, dot: Math.U64, valid: Bool, limit: U32}

type Reply is Data:
  Reply{error: U32, output: Math.U64}

def get2(p: B.Pair<U32>, index: U32) -> U32:
  B.pair_get(U32, p, U32.and(index, 1))

def get4(p: B.Pair<B.Pair<U32>>, +index: U32) -> U32:
  get2(B.pair_get(B.Pair<U32>, p, U32.and(U32.div(index, 2), 1)), index)

def get8(p: B.Pair<B.Pair<B.Pair<U32>>>, +index: U32) -> U32:
  get4(B.pair_get(B.Pair<B.Pair<U32>>, p, U32.and(U32.div(index, 4), 1)), index)

def get16(p: B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>, +index: U32) -> U32:
  get8(B.pair_get(B.Pair<B.Pair<B.Pair<U32>>>, p, U32.and(U32.div(index, 8), 1)), index)

def get32(row: Row, +index: U32) -> U32:
  match row:
    case Row{cells}:
      get16(B.pair_get(B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>, cells, U32.and(U32.div(index, 16), 1)), index)

def byte_negative(value: U32) -> Bool:
  U32.is_ge(value, 128)

def byte_abs_choose(neg: Bool, value: U32) -> U32:
  match neg:
    case True{}:
      U32.sub(256, value)
    case False{}:
      value

def byte_abs(+value: U32) -> U32:
  byte_abs_choose(byte_negative(value), value)

def sign_xor(a: Bool, b: Bool) -> Bool:
  match a:
    case True{}:
      Bool.not(b)
    case False{}:
      b

def signed(absolute: Math.U64, negative: Bool) -> Math.U64:
  match negative:
    case True{}:
      Math.sub_wrap(Math.zero(), absolute)
    case False{}:
      absolute

def product(+q: U32, +w: U32) -> Math.U64:
  signed(Math.mul32(byte_abs(q), byte_abs(w)),
    sign_xor(byte_negative(q), byte_negative(w)))

def negative(value: Math.U64) -> Bool:
  match value:
    case Math.U64{lo, hi}:
      U32.is_ge(hi, 2147483648)

def magnitude_choose(neg: Bool, value: Math.U64) -> Math.U64:
  match neg:
    case True{}:
      Math.sub_wrap(Math.zero(), value)
    case False{}:
      value

def magnitude(+value: Math.U64) -> Math.U64:
  magnitude_choose(negative(value), value)

def shift16_bits(value: Math.U64) -> Math.U64:
  match value:
    case Math.U64{lo, +hi}:
      Math.U64{U32.or(U32.div(lo, 65536), U32.mul(U32.and(hi, 65535), 65536)),
        U32.div(hi, 65536)}

# Basanos rshift_round(v,16) = (v+32768)>>16, including negative ties.
def round16_abs(value: Math.U64, neg: Bool) -> Math.U64:
  match neg:
    case True{}:
      shift16_bits(Math.add_wrap(value, Math.U64{32767, 0}))
    case False{}:
      shift16_bits(Math.add_wrap(value, Math.U64{32768, 0}))

def round16(+value: Math.U64) -> Math.U64:
  +neg = negative(value)
  signed(round16_abs(magnitude(value), neg), neg)

def multiply_scale_abs(absolute: Math.U64, scale: U32, neg: Bool) -> Math.U64:
  match absolute:
    case Math.U64{lo, hi}:
      signed(Math.mul32(lo, scale), neg)

def multiply_scale(+value: Math.U64, scale: U32) -> Math.U64:
  multiply_scale_abs(magnitude(value), scale, negative(value))

def linear_output(dot: Math.U64, m: U32, a: U32) -> Math.U64:
  round16(multiply_scale(round16(multiply_scale(dot, m)), a))

def finish_allowed(allowed: Bool, dot: Math.U64, a: U32, m: U32) -> Reply:
  match allowed:
    case False{}:
      Reply{1, Math.zero()}
    case True{}:
      Reply{0, linear_output(dot, m, a)}

def finish_sum(result: SumResult, +a: U32, +m: U32) -> Reply:
  match result:
    case SumResult{index, dot, valid, +limit}:
      finish_allowed(Bool.and(valid, Bool.and(Bool.not(U32.is_zero(limit)),
        Bool.and(U32.is_le(limit, 32), Bool.and(U32.is_le(a, 1048576), U32.is_le(m, 65535))))),
        dot, a, m)

def advance_if(active: Bool, +index: U32, dot: Math.U64, valid: Bool,
    +q: U32, +w: U32, limit: U32) -> SumResult:
  match active:
    case True{}:
      SumResult{U32.add(index, 1), Math.add_wrap(dot, product(q, w)),
        Bool.and(valid, Bool.and(U32.is_le(q, 255), U32.is_le(w, 255))), limit}
    case False{}:
      SumResult{U32.add(index, 1), dot, valid, limit}

def advance(state: SumResult, q: U32, w: U32) -> SumResult:
  match state:
    case SumResult{+index, dot, valid, +limit}:
      advance_if(U32.is_lt(index, limit), index, dot, valid, q, w, limit)

def fold_rows(q: Row, w: Row, n: U32) -> SumResult:
  match q w:
    case Row{qc} Row{wc}:
      Z.fold32(U32, SumResult, advance, qc, wc,
        SumResult{0, Math.zero(), True{}, n})

def linear(n: U32, +q: Row, +w: Row, a: U32, m: U32) -> Reply:
  finish_sum(fold_rows(q, w, n), a, m)
