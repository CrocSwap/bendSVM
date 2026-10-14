import Base
import ./buffer.bend as B

# Static left-to-right zip folds over homogeneous Pair trees. Each leaf is
# visited exactly once; the caller supplies the accumulator transition.

def fold2(~T: Data, ~A: Data, ~step: A -> T -> T -> A,
    q: B.Pair<T>, w: B.Pair<T>, state: A) -> A:
  match q w:
    case B.Pair{ql, qr} B.Pair{wl, wr}:
      first = step(state, ql, wl)
      step(first, qr, wr)

def fold4(~T: Data, ~A: Data, ~step: A -> T -> T -> A,
    q: B.Pair<B.Pair<T>>, w: B.Pair<B.Pair<T>>, state: A) -> A:
  match q w:
    case B.Pair{ql, qr} B.Pair{wl, wr}:
      first = fold2(T, A, step, ql, wl, state)
      fold2(T, A, step, qr, wr, first)

def fold8(~T: Data, ~A: Data, ~step: A -> T -> T -> A,
    q: B.Pair<B.Pair<B.Pair<T>>>, w: B.Pair<B.Pair<B.Pair<T>>>, state: A) -> A:
  match q w:
    case B.Pair{ql, qr} B.Pair{wl, wr}:
      first = fold4(T, A, step, ql, wl, state)
      fold4(T, A, step, qr, wr, first)

def fold16(~T: Data, ~A: Data, ~step: A -> T -> T -> A,
    q: B.Pair<B.Pair<B.Pair<B.Pair<T>>>>, w: B.Pair<B.Pair<B.Pair<B.Pair<T>>>>, state: A) -> A:
  match q w:
    case B.Pair{ql, qr} B.Pair{wl, wr}:
      first = fold8(T, A, step, ql, wl, state)
      fold8(T, A, step, qr, wr, first)

def fold32(~T: Data, ~A: Data, ~step: A -> T -> T -> A,
    q: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<T>>>>>, w: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<T>>>>>, state: A) -> A:
  match q w:
    case B.Pair{ql, qr} B.Pair{wl, wr}:
      first = fold16(T, A, step, ql, wl, state)
      fold16(T, A, step, qr, wr, first)
