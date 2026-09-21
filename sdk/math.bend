import Base

# Exact unsigned 64-bit representation. Operations below have Bend definitions;
# the compiler has no special knowledge of this module or its callers.
type U64 is Data:
  U64{lo: U32, hi: U32}

type Checked is Data:
  Ok{value: U64}
  Err{code: U32}

def zero() -> U64:
  U64{0, 0}

def equal(a: U64, b: U64) -> Bool:
  match a b:
    case U64{al, ah} U64{bl, bh}:
      Bool.and(U32.is_eq(al, bl), U32.is_eq(ah, bh))

def less(a: U64, b: U64) -> Bool:
  match a b:
    case U64{al, +ah} U64{bl, +bh}:
      Bool.or(U32.is_lt(ah, bh), Bool.and(U32.is_eq(ah, bh), U32.is_lt(al, bl)))

def add_wrap(a: U64, b: U64) -> U64:
  match a b:
    case U64{+al, ah} U64{bl, bh}:
      +lo = U32.add(al, bl)
      hi = U32.add(U32.add(ah, bh), Bool.to_u32(U32.is_lt(lo, al)))
      U64{lo, hi}

def sub_wrap(a: U64, b: U64) -> U64:
  match a b:
    case U64{+al, ah} U64{+bl, bh}:
      U64{U32.sub(al, bl), U32.sub(U32.sub(ah, bh), Bool.to_u32(U32.is_lt(al, bl)))}

# Error codes: 1 overflow, 2 underflow. Wrapping is only used after a guard,
# or internally when checking the carry of addition.
def add_result(overflow: Bool, sum: U64) -> Checked:
  match overflow:
    case True{}:
      Err{1}
    case False{}:
      Ok{sum}

def add(+a: U64, b: U64) -> Checked:
  +sum = add_wrap(a, b)
  add_result(less(sum, a), sum)

def sub_result(underflow: Bool, a: U64, b: U64) -> Checked:
  match underflow:
    case True{}:
      Err{2}
    case False{}:
      Ok{sub_wrap(a, b)}

def sub(+a: U64, +b: U64) -> Checked:
  sub_result(less(a, b), a, b)

# Exact 32 x 32 -> 64 multiplication using four 16-bit partial products.
def mul32_parts(+p0: U32, +p1: U32, +p2: U32, p3: U32) -> U64:
  +middle = U32.add(U32.add(U32.div(p0, 65536), U32.and(p1, 65535)), U32.and(p2, 65535))
  lo = U32.or(U32.and(p0, 65535), U32.mul(U32.and(middle, 65535), 65536))
  hi = U32.add(U32.add(U32.add(p3, U32.div(p1, 65536)), U32.div(p2, 65536)), U32.div(middle, 65536))
  U64{lo, hi}

def mul32(+a: U32, +b: U32) -> U64:
  +al = U32.and(a, 65535)
  +ah = U32.div(a, 65536)
  +bl = U32.and(b, 65535)
  +bh = U32.div(b, 65536)
  mul32_parts(U32.mul(al, bl), U32.mul(ah, bl), U32.mul(al, bh), U32.mul(ah, bh))

def mul_parts(p0: U64, p1: U64, p2: U64, high: Bool) -> Checked:
  match p0 p1 p2:
    case U64{lo, +h0} U64{l1, h1} U64{l2, h2}:
      +sum1 = U32.add(h0, l1)
      +sum2 = U32.add(sum1, l2)
      overflow = Bool.or(high, Bool.or(Bool.not(U32.is_zero(U32.or(h1, h2))), Bool.or(U32.is_lt(sum1, h0), U32.is_lt(sum2, sum1))))
      add_result(overflow, U64{lo, sum2})

def mul(a: U64, b: U64) -> Checked:
  match a b:
    case U64{+al, +ah} U64{+bl, +bh}:
      mul_parts(mul32(al, bl), mul32(al, bh), mul32(ah, bl), Bool.and(Bool.not(U32.is_zero(ah)), Bool.not(U32.is_zero(bh))))

# Fixed 64-step restoring division. Every step shifts one dividend bit into
# the remainder. The extra carry bit must participate in the subtraction test.
# This is ordinary first-order Bend, with bounded composition instead of unsafe
# recursion; generated SBF needs neither a heap nor a recursive call stack.
type Division is Data:
  Division{quotient: U64, remainder: U64}

type DivResult is Data:
  DivOk{value: Division}
  DivErr{code: U32}

type DivState is Data:
  DivState{quotient: U64, remainder: U64, divisor: U64}

def top(a: U64) -> U32:
  match a:
    case U64{lo, hi}:
      Bool.to_u32(U32.is_ge(hi, 2147483648))

def shift_in(a: U64, bit: U32) -> U64:
  match a:
    case U64{+lo, hi}:
      U64{U32.or(U32.shl(lo), bit), U32.or(U32.shl(hi), Bool.to_u32(U32.is_ge(lo, 2147483648)))}

def set_low(a: U64) -> U64:
  match a:
    case U64{lo, hi}:
      U64{U32.or(lo, 1), hi}

def div_reduce(reduce: Bool, q: U64, r: U64, +d: U64) -> DivState:
  match reduce:
    case False{}:
      DivState{q, r, d}
    case True{}:
      DivState{set_low(q), sub_wrap(r, d), d}

def div_step(state: DivState) -> DivState:
  match state:
    case DivState{+q, +r, +d}:
      +next = shift_in(r, top(q))
      reduce = Bool.or(Bool.not(U32.is_zero(top(r))), Bool.not(less(next, d)))
      div_reduce(reduce, shift_in(q, 0), next, d)

def div2(s: DivState) -> DivState:
  div_step(div_step(s))

def div4(s: DivState) -> DivState:
  div2(div2(s))

def div8(s: DivState) -> DivState:
  div4(div4(s))

def div16(s: DivState) -> DivState:
  div8(div8(s))

def div32(s: DivState) -> DivState:
  div16(div16(s))

def div64(s: DivState) -> DivState:
  div32(div32(s))

def div_finish(s: DivState) -> DivResult:
  match s:
    case DivState{q, r, d}:
      DivOk{Division{q, r}}

def div_guard(is_zero: Bool, a: U64, b: U64) -> DivResult:
  match is_zero:
    case True{}:
      DivErr{3}
    case False{}:
      div_finish(div64(DivState{a, zero(), b}))

def divmod(a: U64, +b: U64) -> DivResult:
  div_guard(equal(b, zero()), a, b)

def quotient(result: DivResult) -> Checked:
  match result:
    case DivErr{code}:
      Err{code}
    case DivOk{Division{q, r}}:
      Ok{q}

def remainder(result: DivResult) -> Checked:
  match result:
    case DivErr{code}:
      Err{code}
    case DivOk{Division{q, r}}:
      Ok{r}

def div(a: U64, b: U64) -> Checked:
  quotient(divmod(a, b))

def mod(a: U64, b: U64) -> Checked:
  remainder(divmod(a, b))
