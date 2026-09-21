import ./math.bend as Math

type Key is Data:
  Key{a: U32, b: U32, c: U32, d: U32, e: U32, f: U32, g: U32, h: U32}

type Context is Data:
  Context{actor: Key, signed: Bool, slot: Math.U64}

def equal(a: Key, b: Key) -> Bool:
  match a b:
    case Key{a0, a1, a2, a3, a4, a5, a6, a7} Key{b0, b1, b2, b3, b4, b5, b6, b7}:
      Bool.and(Bool.and(Bool.and(U32.is_eq(a0, b0), U32.is_eq(a1, b1)), Bool.and(U32.is_eq(a2, b2), U32.is_eq(a3, b3))), Bool.and(Bool.and(U32.is_eq(a4, b4), U32.is_eq(a5, b5)), Bool.and(U32.is_eq(a6, b6), U32.is_eq(a7, b7))))
