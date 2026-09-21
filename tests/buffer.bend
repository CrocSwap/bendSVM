import Base
import ../sdk/buffer.bend as B

def read_word(storage: B.Pair<B.Pair<U32>>, index: U32) -> U32:
  B.quad_get(U32, storage, index)

def write_word(storage: B.Pair<B.Pair<U32>>, index: U32, value: U32) -> B.Pair<B.Pair<U32>>:
  B.quad_set(U32, storage, index, value)

def read_flag(storage: B.Pair<Bool>, index: U32) -> Bool:
  B.pair_get(Bool, storage, index)

def write_flag(storage: B.Pair<Bool>, index: U32, value: Bool) -> B.Pair<Bool>:
  B.pair_set(Bool, storage, index, value)

def get_word(vector: B.Vector<U32, B.Pair<B.Pair<U32>>>, index: U32) -> B.Result<U32>:
  B.get(U32, B.Pair<B.Pair<U32>>, 4, read_word, vector, index)

def set_word(vector: B.Vector<U32, B.Pair<B.Pair<U32>>>, index: U32, value: U32) -> B.Result<B.Vector<U32, B.Pair<B.Pair<U32>>>>:
  B.set(U32, B.Pair<B.Pair<U32>>, 4, write_word, vector, index, value)

def push_word(vector: B.Vector<U32, B.Pair<B.Pair<U32>>>, value: U32) -> B.Result<B.Vector<U32, B.Pair<B.Pair<U32>>>>:
  B.push(U32, B.Pair<B.Pair<U32>>, 4, write_word, vector, value)

def get_flag(vector: B.Vector<Bool, B.Pair<Bool>>, index: U32) -> B.Result<Bool>:
  B.get(Bool, B.Pair<Bool>, 2, read_flag, vector, index)

def set_flag(vector: B.Vector<Bool, B.Pair<Bool>>, index: U32, value: Bool) -> B.Result<B.Vector<Bool, B.Pair<Bool>>>:
  B.set(Bool, B.Pair<Bool>, 2, write_flag, vector, index, value)

def push_flag(vector: B.Vector<Bool, B.Pair<Bool>>, value: Bool) -> B.Result<B.Vector<Bool, B.Pair<Bool>>>:
  B.push(Bool, B.Pair<Bool>, 2, write_flag, vector, value)
