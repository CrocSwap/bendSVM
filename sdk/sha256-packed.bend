import ./buffer.bend as B
import ./iteration.bend as I
import ./sha256-reference.bend as S

# Bounded packed SHA-256 reference: 160 input bytes, lengths 0..151.
# Ordinary lowering executes this Bend body; explicit qualified emission is separate.
type Bytes160 is Data:
  Bytes160{words: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>>, tail: B.Pair<B.Pair<B.Pair<U32>>>}

type Message is Data:
  Message{length: U32, bytes: Bytes160}

type WordBuild is Data:
  WordBuild{bytes: Bytes160, length: U32, words: S.Words16, index: U32, block: U32}

def get32(tree: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>>, +index: U32) -> U32:
  +p4 = B.pair_get(B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>, tree, U32.div(index, 16))
  +p3 = B.pair_get(B.Pair<B.Pair<B.Pair<U32>>>, p4, U32.mod(U32.div(index, 8), 2))
  +p2 = B.pair_get(B.Pair<B.Pair<U32>>, p3, U32.mod(U32.div(index, 4), 2))
  +p1 = B.pair_get(B.Pair<U32>, p2, U32.mod(U32.div(index, 2), 2))
  B.pair_get(U32, p1, U32.mod(index, 2))

# Each U32 packs four bytes in little-endian order. Every U32 value is valid.
def get8(tree: B.Pair<B.Pair<B.Pair<U32>>>, +index: U32) -> U32:
  +p2 = B.pair_get(B.Pair<B.Pair<U32>>, tree, U32.div(index, 4))
  +p1 = B.pair_get(B.Pair<U32>, p2, U32.mod(U32.div(index, 2), 2))
  B.pair_get(U32, p1, U32.mod(index, 2))

def packed_route(first: Bool, bytes: Bytes160, index: U32) -> U32:
  match first bytes:
    case True{} Bytes160{words, tail}:
      get32(words, index)
    case False{} Bytes160{words, tail}:
      get8(tail, U32.sub(index, 32))

def byte_divisor(low: Bool, +offset: U32) -> U32:
  match low:
    case True{}:
      S.pick_word(1, 256, U32.is_zero(offset))
    case False{}:
      S.pick_word(65536, 16777216, U32.is_eq(offset, 2))

def byte_at(bytes: Bytes160, +index: U32) -> U32:
  +word_index = U32.div(index, 4)
  +word = packed_route(U32.is_lt(word_index, 32), bytes, word_index)
  +offset = U32.mod(index, 4)
  U32.mod(U32.div(word, byte_divisor(U32.is_lt(offset, 2), offset)), 256)

def length_valid(length: U32) -> Bool:
  U32.is_le(length, 151)

def block_count(length: U32) -> U32:
  U32.div(U32.add(length, 72), 64)

def suffix_low(last: Bool, length: U32) -> U32:
  match last:
    case True{}:
      U32.mod(U32.mul(length, 8), 256)
    case False{}:
      0

def suffix_high(high: Bool, +length: U32, index: U32, total: U32) -> U32:
  match high:
    case True{}:
      U32.div(U32.mul(length, 8), 256)
    case False{}:
      suffix_low(U32.is_eq(index, U32.sub(total, 1)), length)

def pad_end(at_end: Bool, +length: U32, +index: U32) -> U32:
  match at_end:
    case True{}:
      128
    case False{}:
      +total = U32.mul(block_count(length), 64)
      suffix_high(U32.is_eq(index, U32.sub(total, 2)), length, index, total)

def pad_route(active: Bool, bytes: Bytes160, +length: U32, +index: U32) -> U32:
  match active:
    case True{}:
      byte_at(bytes, index)
    case False{}:
      pad_end(U32.is_eq(index, length), length, index)

def padded_byte(bytes: Bytes160, +length: U32, +index: U32) -> U32:
  pad_route(U32.is_lt(index, length), bytes, length, index)

def word_at(+bytes: Bytes160, +length: U32, +base: U32) -> U32:
  +a = padded_byte(bytes, length, base)
  +b = padded_byte(bytes, length, U32.add(base, 1))
  +c = padded_byte(bytes, length, U32.add(base, 2))
  d = padded_byte(bytes, length, U32.add(base, 3))
  U32.add(U32.add(U32.mul(a, 16777216), U32.mul(b, 65536)), U32.add(U32.mul(c, 256), d))

def word_step(state: WordBuild) -> WordBuild:
  match state:
    case WordBuild{+bytes, +length, words, +index, +block}:
      +value = word_at(bytes, length, U32.add(block, U32.mul(index, 4)))
      WordBuild{bytes, length, S.words16_set(words, index, value), U32.add(index, 1), block}

def word_result(state: WordBuild) -> S.Words16:
  match state:
    case WordBuild{bytes, length, words, index, block}:
      words

def initial_words(bytes: Bytes160, length: U32, block: U32) -> S.Words16:
  word_result(I.repeat(WordBuild, word_step, 16n, WordBuild{bytes, length, S.words16_zero(), 0, block}))

def add_digest(initial: S.Digest256, finished: S.RoundState) -> S.Digest256:
  match initial finished:
    case S.Digest256{a, b, c, d, e, f, g, h} S.RoundState{words, index, aa, bb, cc, dd, ee, ff, gg, hh}:
      S.Digest256{U32.add(a, aa), U32.add(b, bb), U32.add(c, cc), U32.add(d, dd),
        U32.add(e, ee), U32.add(f, ff), U32.add(g, gg), U32.add(h, hh)}

def compress_from(+initial: S.Digest256, words: S.Words16) -> S.Digest256:
  match initial:
    case S.Digest256{a, b, c, d, e, f, g, h}:
      add_digest(initial, I.repeat(S.RoundState, S.round_step, 64n,
        S.RoundState{words, 0, a, b, c, d, e, f, g, h}))

def finish_third(required: Bool, bytes: Bytes160, length: U32, digest: S.Digest256) -> S.HashResult:
  match required:
    case False{}:
      S.Hashed{digest}
    case True{}:
      S.Hashed{compress_from(digest, initial_words(bytes, length, 128))}

def finish_second(required: Bool, +bytes: Bytes160, +length: U32, digest: S.Digest256) -> S.HashResult:
  match required:
    case False{}:
      S.Hashed{digest}
    case True{}:
      +next = compress_from(digest, initial_words(bytes, length, 64))
      finish_third(U32.is_ge(length, 120), bytes, length, next)

def initial_digest() -> S.Digest256:
  S.Digest256{1779033703, 3144134277, 1013904242, 2773480762,
    1359893119, 2600822924, 528734635, 1541459225}

def hash_bytes(+bytes: Bytes160, +length: U32) -> S.HashResult:
  +first = compress_from(initial_digest(), initial_words(bytes, length, 0))
  finish_second(U32.is_ge(length, 56), bytes, length, first)

def hash_length(valid: Bool, +bytes: Bytes160, +length: U32) -> S.HashResult:
  match valid:
    case False{}:
      S.Rejected{}
    case True{}:
      hash_bytes(bytes, length)

def hash_bounded(message: Message) -> S.HashResult:
  match message:
    case Message{+length, bytes}:
      hash_length(length_valid(length), bytes, length)
