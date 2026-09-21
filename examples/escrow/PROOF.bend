import ./LAWS.bend as Laws
import ./escrow.bend as Escrow

def Laws.preserves_amount(authorized, state):
  match authorized state:
    case False{} Escrow.Locked{value}:
      {==}
    case False{} Escrow.Released{value}:
      {==}
    case True{} Escrow.Locked{value}:
      {==}
    case True{} Escrow.Released{value}:
      {==}

def Laws.unauthorized_unchanged(state):
  {==}

def Laws.authorized_releases(value):
  {==}

def Laws.release_idempotent(authorized, state):
  match authorized state:
    case False{} Escrow.Locked{value}:
      {==}
    case False{} Escrow.Released{value}:
      {==}
    case True{} Escrow.Locked{value}:
      {==}
    case True{} Escrow.Released{value}:
      {==}
