import Base
import ../sdk/collection.bend as C
import ../sdk/buffer.bend as B

def read_range(metadata: C.Metadata, start: U32, count: U32, maximum: U32) -> B.Result<C.Range>:
  C.read_range(metadata, start, count, maximum)

def reserve_range(metadata: C.Metadata, start: U32, count: U32, maximum: U32) -> B.Result<C.Range>:
  C.reserve_range(metadata, start, count, maximum)

def get_word(window: C.Window<U32, B.Pair<B.Pair<U32>>>, index: U32) -> B.Result<U32>:
  C.get(U32, B.Pair<B.Pair<U32>>, 4, storage => index => B.quad_get(U32, storage, index), window, index)

def get_flag(window: C.Window<Bool, B.Pair<Bool>>, index: U32) -> B.Result<Bool>:
  C.get(Bool, B.Pair<Bool>, 2, storage => index => B.pair_get(Bool, storage, index), window, index)

def set_word(window: C.Window<U32, B.Pair<B.Pair<U32>>>, index: U32, value: U32) -> B.Result<C.Window<U32, B.Pair<B.Pair<U32>>>>:
  C.set(U32, B.Pair<B.Pair<U32>>, 4, storage => index => value => B.quad_set(U32, storage, index, value), window, index, value)

def set_flag(window: C.Window<Bool, B.Pair<Bool>>, index: U32, value: Bool) -> B.Result<C.Window<Bool, B.Pair<Bool>>>:
  C.set(Bool, B.Pair<Bool>, 2, storage => index => value => B.pair_set(Bool, storage, index, value), window, index, value)

def push_word(window: C.Window<U32, B.Pair<B.Pair<U32>>>, value: U32) -> B.Result<C.Window<U32, B.Pair<B.Pair<U32>>>>:
  C.push(U32, B.Pair<B.Pair<U32>>, 4, storage => index => value => B.quad_set(U32, storage, index, value), window, value)

def push_flag(window: C.Window<Bool, B.Pair<Bool>>, value: Bool) -> B.Result<C.Window<Bool, B.Pair<Bool>>>:
  C.push(Bool, B.Pair<Bool>, 2, storage => index => value => B.pair_set(Bool, storage, index, value), window, value)
