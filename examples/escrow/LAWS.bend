import ./escrow.bend as Escrow

law preserves_amount:
  for authorized: Bool
  for state: Escrow.Escrow
  {Escrow.amount(Escrow.release(authorized, state)) == Escrow.amount(state) : Escrow.Amount}

law unauthorized_unchanged:
  for state: Escrow.Escrow
  {Escrow.release(False{}, state) == state : Escrow.Escrow}

law authorized_releases:
  for value: Escrow.Amount
  {Escrow.release(True{}, Escrow.Locked{value}) == Escrow.Released{value} : Escrow.Escrow}

law release_idempotent:
  for authorized: Bool
  for state: Escrow.Escrow
  {Escrow.release(authorized, Escrow.release(authorized, state)) == Escrow.release(authorized, state) : Escrow.Escrow}
