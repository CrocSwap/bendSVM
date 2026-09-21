import ../sdk/math.bend as Math
import ../sdk/PROOF.bend as MathProof

type Reply is Data:
  Reply{error: U32, lo: U32, hi: U32}

def encode(result: Math.Checked) -> Reply:
  match result:
    case Math.Err{code}:
      Reply{code, 0, 0}
    case Math.Ok{Math.U64{lo, hi}}:
      Reply{0, lo, hi}

def add64(al: U32, ah: U32, bl: U32, bh: U32) -> Reply:
  encode(Math.add(Math.U64{al, ah}, Math.U64{bl, bh}))

def sub64(al: U32, ah: U32, bl: U32, bh: U32) -> Reply:
  encode(Math.sub(Math.U64{al, ah}, Math.U64{bl, bh}))

def less64(al: U32, ah: U32, bl: U32, bh: U32) -> Bool:
  Math.less(Math.U64{al, ah}, Math.U64{bl, bh})

def equal64(al: U32, ah: U32, bl: U32, bh: U32) -> Bool:
  Math.equal(Math.U64{al, ah}, Math.U64{bl, bh})

def mul64(al: U32, ah: U32, bl: U32, bh: U32) -> Reply:
  encode(Math.mul(Math.U64{al, ah}, Math.U64{bl, bh}))

def div64(al: U32, ah: U32, bl: U32, bh: U32) -> Reply:
  encode(Math.div(Math.U64{al, ah}, Math.U64{bl, bh}))

def mod64(al: U32, ah: U32, bl: U32, bh: U32) -> Reply:
  encode(Math.mod(Math.U64{al, ah}, Math.U64{bl, bh}))
