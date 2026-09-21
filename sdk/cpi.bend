import ./context.bend as Sol

# Fixed-capacity CPI values. Words encode little-endian bytes; length chooses
# the transmitted prefix (up to 64 bytes). Unused payload bytes must be zero.
type Bytes64 is Data:
  Bytes64{a: U32, b: U32, c: U32, d: U32, e: U32, f: U32, g: U32, h: U32, i: U32, j: U32, k: U32, l: U32, m: U32, n: U32, o: U32, p: U32}

type Meta is Data:
  Meta{index: U32, key: Sol.Key, writable: Bool, signer: Bool}

type Metas is Data:
  Metas{a: Meta, b: Meta, c: Meta, d: Meta, e: Meta, f: Meta, g: Meta, h: Meta}

type Effect is Data:
  None{}
  Invoke{program: U32, program_key: Sol.Key, length: U32, data: Bytes64, count: U32, accounts: Metas}

type Effects is Data:
  Effects{first: Effect, second: Effect}

def none() -> Effects:
  Effects{None{}, None{}}

def one(effect: Effect) -> Effects:
  Effects{effect, None{}}
