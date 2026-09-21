import ./context.bend as Sol
import ./math.bend as Math

type Authority is Data:
  Actor{}
  Custody{}

type Recipient is Data:
  ToActor{}
  ToCustody{}
  ToOwner{key: Sol.Key}

type Effect is Data:
  None{}
  Transfer{source: U32, destination: U32, mint: U32, mint_key: Sol.Key, recipient: Recipient, amount: Math.U64, authority: Authority}
  CheckMint{mint: U32, mint_key: Sol.Key}

type Effects is Data:
  Effects{first: Effect, second: Effect}

def none() -> Effects:
  Effects{None{}, None{}}

def one(effect: Effect) -> Effects:
  Effects{effect, None{}}
