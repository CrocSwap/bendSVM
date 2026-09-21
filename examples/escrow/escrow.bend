import Base

# An unsigned 64-bit amount, represented exactly by two 32-bit limbs.
# This example moves amounts without performing arithmetic on them.
type Amount is Data:
  Amount{lo: U32, hi: U32}

type Escrow is Data:
  Locked{amount: Amount}
  Released{amount: Amount}

def release_allowed(escrow: Escrow) -> Escrow:
  match escrow:
    case Locked{amount}:
      Released{amount}
    case Released{amount}:
      Released{amount}

def release(authorized: Bool, escrow: Escrow) -> Escrow:
  match authorized:
    case False{}:
      escrow
    case True{}:
      release_allowed(escrow)

def amount(escrow: Escrow) -> Amount:
  match escrow:
    case Locked{value}:
      value
    case Released{value}:
      value
