import ./LAWS.bend as Laws
import ./exchange.bend as Ex
import ../../sdk/PROOF.bend as MathProof

def Laws.bad_quantity(offer, amount, maximum):
  {==}

def Laws.bad_slippage(offer, amount, payment):
  {==}

def Laws.unsigned_fill(actor, slot, offer, amount, maximum):
  {==}

def Laws.unsigned_cancel(actor, slot, offer):
  match offer:
    case Ex.Offer{maker, base, quote, remaining, numerator, denominator}:
      {==}

def Laws.closed_terminal(context, instruction):
  {==}
