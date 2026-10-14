import Base
import ./math.bend as Math

# Signed two's-complement operations with explicit widths. U64 carries bits;
# it is not interpreted as an unsigned magnitude by this module.

def extend32(+bits: U32) -> Math.U64:
  Math.U64{bits, U32.mul(Bool.to_u32(U32.is_ge(bits, 2147483648)), 4294967295)}

def byte_bits_choose(negative: Bool, bits: U32) -> U32:
  match negative:
    case False{}:
      bits
    case True{}:
      U32.sub(bits, 256)

# Decode the low eight bits as a signed byte; higher input bits are discarded.
# Applications requiring canonical byte cells must validate value <= 255.
def byte_bits_low(+bits: U32) -> U32:
  byte_bits_choose(U32.is_ge(bits, 128), bits)

def byte_bits(value: U32) -> U32:
  byte_bits_low(U32.and(value, 255))

# Exact signed product of two low-byte values, sign-extended into 64 bits.
def mul8(left: U32, right: U32) -> Math.U64:
  extend32(U32.mul(byte_bits(left), byte_bits(right)))

# Add low 32-bit words modulo 2^32 and sign-extend the result. This deliberately
# discards the input high words. Equivalence to signed 64-bit addition requires
# the caller to establish signed-32 input and result bounds.
def add32_wrap(left: Math.U64, right: Math.U64) -> Math.U64:
  match left right:
    case Math.U64{a, ah} Math.U64{b, bh}:
      extend32(U32.add(a, b))
