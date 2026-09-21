import Base

# Structurally decreasing fuel. The SBF subset represents Nat as a bounded
# integer (0..64). The step and state types specialize at compile time.
def repeat(~S: Data, ~step: S -> S, fuel: Nat, state: S) -> S:
  match fuel:
    case Zero{}:
      state
    case Succ{pred}:
      repeat(S, step, pred, step(state))
