import ./context.bend as Sol
import ./math.bend as Math
import ./effects.bend as Fx

type Binding is Data:
  Any{}
  Exact{key: Sol.Key}

type TransferDetails is Data:
  TransferDetails{source: U32, destination: U32, mint: U32, mint_key: Sol.Key, recipient: Fx.Recipient, amount: Math.U64, authority: Fx.Authority}

# Three atomic effects including issuance for a custody-controlled SPL mint.
# Mint/Burn require the custody PDA as mint authority and no freeze authority.
# Mint signs with custody; Burn requires the actor to own the source and sign.
type Effect is Data:
  None{}
  Transfer{source: U32, destination: U32, mint: U32, mint_key: Sol.Key, recipient: Fx.Recipient, amount: Math.U64, authority: Fx.Authority}
  CheckMint{mint: U32, mint_key: Sol.Key}
  Mint{destination: U32, mint: U32, mint_key: Sol.Key, recipient: Fx.Recipient, amount: Math.U64, initialize: Bool}
  Burn{source: U32, mint: U32, mint_key: Sol.Key, amount: Math.U64}
  BoundTransfer{transfer: TransferDetails, source: Binding, destination: Binding, fresh_destination: Bool}

type Effects is Data:
  Effects{first: Effect, second: Effect, third: Effect}

def none() -> Effects:
  Effects{None{}, None{}, None{}}

def one(effect: Effect) -> Effects:
  Effects{effect, None{}, None{}}
