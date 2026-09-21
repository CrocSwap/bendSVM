import Base

# These definitions are written once and checked for all Data element types.
type Box<-T: Data> is Data:
  Box{value: T}

type Choice<-T: Data> is Data:
  Absent{}
  Present{value: T}

def box(~T: Data, value: T) -> Box<T>:
  Box{value}

def unbox(~T: Data, value: Box<T>) -> T:
  match value:
    case Box{value}:
      value

def fallback(~T: Data, choice: Choice<T>, other: T) -> T:
  match choice:
    case Absent{}:
      other
    case Present{value}:
      value

def word(value: U32) -> Box<U32>:
  box(U32, value)

def flag(value: Bool) -> Box<Bool>:
  box(Bool, value)

def nested(value: U32) -> Box<Box<U32>>:
  box(Box<U32>, box(U32, value))

def unwrap(value: Box<Box<U32>>) -> U32:
  unbox(U32, unbox(Box<U32>, value))

def choose_word(choice: Choice<U32>, other: U32) -> U32:
  fallback(U32, choice, other)

def choose_flag(choice: Choice<Bool>, other: Bool) -> Bool:
  fallback(Bool, choice, other)

def present(value: U32) -> Choice<U32>:
  Present{value}

def absent() -> Choice<Bool>:
  Absent{}
