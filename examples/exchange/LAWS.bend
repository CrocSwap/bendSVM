import ./exchange.bend as Ex
import ../../sdk/context.bend as Sol
import ../../sdk/math.bend as Math

law bad_quantity:
  for offer: Ex.Offer
  for amount: Math.U64
  for maximum: Math.U64
  {Ex.fill_valid(False{}, offer, amount, maximum) == Ex.Rejected{4} : Ex.Outcome}

law bad_slippage:
  for offer: Ex.Offer
  for amount: Math.U64
  for payment: Math.U64
  {Ex.slippage(False{}, offer, amount, payment) == Ex.Rejected{5} : Ex.Outcome}

law unsigned_fill:
  for actor: Sol.Key
  for slot: Math.U64
  for offer: Ex.Offer
  for amount: Math.U64
  for maximum: Math.U64
  {Ex.process(Sol.Context{actor, False{}, slot}, Ex.Open{offer}, Ex.Fill{amount, maximum}) == Ex.Rejected{1} : Ex.Outcome}

law unsigned_cancel:
  for actor: Sol.Key
  for slot: Math.U64
  for offer: Ex.Offer
  {Ex.process(Sol.Context{actor, False{}, slot}, Ex.Open{offer}, Ex.Cancel{}) == Ex.Rejected{1} : Ex.Outcome}

law closed_terminal:
  for context: Sol.Context
  for instruction: Ex.Instruction
  {Ex.process(context, Ex.Closed{}, instruction) == Ex.Rejected{7} : Ex.Outcome}
