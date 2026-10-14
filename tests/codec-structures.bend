import Base

type EmptyUnit is Data:
  EmptyUnit{}

type Small is Data:
  Empty{}
  Flag{value: Bool}

type Mixed is Data:
  Mixed{first: Small, fuel: Nat, word: U32, last: Small}

type Deep is Data:
  Deep{left: Mixed, middle: Small, right: Mixed, unit: EmptyUnit}

def identity(value: Deep) -> Deep:
  value
