import Base

type Duo is Data:
  Duo{left: U32, right: U32}

def swap(pair: Duo) -> Duo:
  match pair:
    case Duo{left, right}:
      Duo{right, left}

def first(pair: Duo) -> U32:
  match pair:
    case Duo{left, right}:
      left

def select(use_right: Bool, pair: Duo) -> U32:
  match use_right:
    case False{}:
      first(pair)
    case True{}:
      first(swap(pair))

def maximum() -> U32:
  4294967295

def locals(pair: Duo) -> Duo:
  reversed = swap(pair)
  swap(reversed)

law swap_twice:
  for pair: Duo
  {swap(swap(pair)) == pair : Duo}

def swap_twice(pair):
  match pair:
    case Duo{left, right}:
      {==}
