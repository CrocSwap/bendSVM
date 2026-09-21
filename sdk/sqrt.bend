import ./math.bend as Math
import ./wide.bend as Wide

# Unsigned integer square root of a full 128-bit value. Trial bits run from
# bit 63 to bit 0, with no recursion or heap. A candidate is retained exactly
# when its full-width square does not exceed the target.
type Search is Data:
  Search{target: Wide.U128, root: Math.U64, bit: Math.U64}

def less(a: Wide.U128, b: Wide.U128) -> Bool:
  match a b:
    case Wide.U128{al, +ah} Wide.U128{bl, +bh}:
      Bool.or(Math.less(ah, bh), Bool.and(Math.equal(ah, bh), Math.less(al, bl)))

def half(value: Math.U64) -> Math.U64:
  match value:
    case Math.U64{lo, +hi}:
      Math.U64{U32.add(U32.div(lo, 2), U32.mul(U32.and(hi, 1), 2147483648)), U32.div(hi, 2)}

def choose(fits: Bool, target: Wide.U128, root: Math.U64, candidate: Math.U64, bit: Math.U64) -> Search:
  match fits:
    case False{}:
      Search{target, root, half(bit)}
    case True{}:
      Search{target, candidate, half(bit)}

def trial(+target: Wide.U128, root: Math.U64, +candidate: Math.U64, bit: Math.U64) -> Search:
  choose(Bool.not(less(target, Wide.product(candidate, candidate))), target, root, candidate, bit)

def step(state: Search) -> Search:
  match state:
    case Search{target, +root, +bit}:
      trial(target, root, Math.add_wrap(root, bit), bit)

def step2(state: Search) -> Search:
  step(step(state))

def step4(state: Search) -> Search:
  step2(step2(state))

def step8(state: Search) -> Search:
  step4(step4(state))

def step16(state: Search) -> Search:
  step8(step8(state))

def step32(state: Search) -> Search:
  step16(step16(state))

def step64(state: Search) -> Search:
  step32(step32(state))

def finish(state: Search) -> Math.U64:
  match state:
    case Search{target, root, bit}:
      root

def floor(value: Wide.U128) -> Math.U64:
  finish(step64(Search{value, Math.zero(), Math.U64{0, 2147483648}}))

def geometric_mean(a: Math.U64, b: Math.U64) -> Math.U64:
  floor(Wide.product(a, b))
