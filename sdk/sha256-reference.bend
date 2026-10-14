import Base
import ./buffer.bend as B
import ./iteration.bend as I

# A deliberately small, source-level SHA-256 reference. Message bytes are
# represented as U32 words so callers cannot smuggle host byte arrays into the
# checked source boundary. hash_short accepts one padded block: 0..55 bytes.
type Bytes64 is Data:
  Bytes64{words: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>>>}

type Message is Data:
  Message{length: U32, bytes: Bytes64}

type Words16 is Data:
  Words16{words: B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>}

type Digest256 is Data:
  Digest256{h0: U32, h1: U32, h2: U32, h3: U32, h4: U32, h5: U32, h6: U32, h7: U32}

type HashResult is Data:
  Rejected{}
  Hashed{digest: Digest256}

type ByteScan is Data:
  ByteScan{bytes: Bytes64, length: U32, index: U32, valid: Bool}

type WordBuild is Data:
  WordBuild{bytes: Bytes64, length: U32, words: Words16, index: U32}

type SelectedWord is Data:
  SelectedWord{words: Words16, value: U32}

type RoundState is Data:
  RoundState{words: Words16, index: U32, a: U32, b: U32, c: U32, d: U32,
    e: U32, f: U32, g: U32, h: U32}

type RoundInput is Data:
  RoundInput{selected: SelectedWord, index: U32, a: U32, b: U32, c: U32,
    d: U32, e: U32, f: U32, g: U32, h: U32}

def byte_value(value: U32) -> Bool:
  U32.is_le(value, 255)

def short_length(length: U32) -> Bool:
  U32.is_le(length, 55)

def get64(tree: B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>>>,
    +index: U32) -> U32:
  +level5 = B.pair_get(B.Pair<B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>>, tree,
    U32.div(index, 32))
  +level4 = B.pair_get(B.Pair<B.Pair<B.Pair<B.Pair<U32>>>>, level5,
    U32.mod(U32.div(index, 16), 2))
  +level3 = B.pair_get(B.Pair<B.Pair<B.Pair<U32>>>, level4,
    U32.mod(U32.div(index, 8), 2))
  +level2 = B.pair_get(B.Pair<B.Pair<U32>>, level3,
    U32.mod(U32.div(index, 4), 2))
  +level1 = B.pair_get(B.Pair<U32>, level2,
    U32.mod(U32.div(index, 2), 2))
  B.pair_get(U32, level1, U32.mod(index, 2))

def bytes_get(bytes: Bytes64, index: U32) -> U32:
  match bytes:
    case Bytes64{words}:
      get64(words, index)

def words16_get(words: Words16, +index: U32) -> U32:
  match words:
    case Words16{words}:
      +group = B.quad_get(B.Pair<B.Pair<U32>>, words, U32.div(index, 4))
      B.quad_get(U32, group, U32.mod(index, 4))

def words16_set(+words: Words16, +index: U32, value: U32) -> Words16:
  match words:
    case Words16{+words}:
      +group = B.quad_get(B.Pair<B.Pair<U32>>, words, U32.div(index, 4))
      +updated = B.quad_set(U32, group, U32.mod(index, 4), value)
      Words16{B.quad_set(B.Pair<B.Pair<U32>>, words, U32.div(index, 4), updated)}

def words16_zero() -> Words16:
  Words16{B.Pair{B.Pair{B.Pair{B.Pair{0, 0}, B.Pair{0, 0}},
    B.Pair{B.Pair{0, 0}, B.Pair{0, 0}}},
    B.Pair{B.Pair{B.Pair{0, 0}, B.Pair{0, 0}},
      B.Pair{B.Pair{0, 0}, B.Pair{0, 0}}}}}

def scan_active_byte(state: ByteScan) -> ByteScan:
  match state:
    case ByteScan{+bytes, length, +index, valid}:
      +is_byte = byte_value(bytes_get(bytes, index))
      ByteScan{bytes, length, U32.add(index, 1), Bool.and(valid, is_byte)}

def scan_inactive_byte(state: ByteScan) -> ByteScan:
  match state:
    case ByteScan{bytes, length, +index, valid}:
      ByteScan{bytes, length, U32.add(index, 1), valid}

def scan_byte_if_active(active: Bool, state: ByteScan) -> ByteScan:
  match active:
    case False{}:
      scan_inactive_byte(state)
    case True{}:
      scan_active_byte(state)

def scan_byte_step(state: ByteScan) -> ByteScan:
  match state:
    case ByteScan{+bytes, +length, +index, valid}:
      scan_byte_if_active(U32.is_lt(index, length), ByteScan{bytes, length, index, valid})

def scan_valid(scan: ByteScan) -> Bool:
  match scan:
    case ByteScan{bytes, length, index, valid}:
      valid

def active_bytes_valid(bytes: Bytes64, length: U32) -> Bool:
  scan_valid(I.repeat(ByteScan, scan_byte_step, 64n,
    ByteScan{bytes, length, 0, True{}}))

def padded_byte_length_low(at_suffix_lo: Bool, length: U32) -> U32:
  match at_suffix_lo:
    case True{}:
      U32.mod(U32.mul(length, 8), 256)
    case False{}:
      0

def padded_byte_length_high(at_suffix_hi: Bool, +length: U32,
    index: U32) -> U32:
  match at_suffix_hi:
    case True{}:
      U32.div(U32.mul(length, 8), 256)
    case False{}:
      padded_byte_length_low(U32.is_eq(index, 63), length)

def padded_byte_before_suffix(before_suffix: Bool, +length: U32,
    +index: U32) -> U32:
  match before_suffix:
    case True{}:
      0
    case False{}:
      padded_byte_length_high(U32.is_eq(index, 62), length, index)

def padded_byte_at_end(at_end: Bool, +bytes: Bytes64, +length: U32,
    +index: U32) -> U32:
  match at_end:
    case True{}:
      128
    case False{}:
      padded_byte_before_suffix(U32.is_lt(index, 56), length, index)

def padded_byte_before(before_end: Bool, +bytes: Bytes64, +length: U32,
    +index: U32) -> U32:
  match before_end:
    case True{}:
      bytes_get(bytes, index)
    case False{}:
      padded_byte_at_end(U32.is_eq(index, length), bytes, length, index)

def padded_byte(+bytes: Bytes64, +length: U32, +index: U32) -> U32:
  padded_byte_before(U32.is_lt(index, length), bytes, length, index)

def block_word(+bytes: Bytes64, +length: U32, word_index: U32) -> U32:
  +base = U32.mul(word_index, 4)
  +b0 = padded_byte(bytes, length, base)
  +b1 = padded_byte(bytes, length, U32.add(base, 1))
  +b2 = padded_byte(bytes, length, U32.add(base, 2))
  b3 = padded_byte(bytes, length, U32.add(base, 3))
  +top = U32.mul(b0, 16777216)
  +upper = U32.mul(b1, 65536)
  +lower = U32.mul(b2, 256)
  U32.add(U32.add(top, upper), U32.add(lower, b3))

def build_word_step(state: WordBuild) -> WordBuild:
  match state:
    case WordBuild{+bytes, +length, +words, +index}:
      +value = block_word(bytes, length, index)
      +updated = words16_set(words, index, value)
      WordBuild{bytes, length, updated, U32.add(index, 1)}

def build_result(built: WordBuild) -> Words16:
  match built:
    case WordBuild{bytes, length, words, index}:
      words

def initial_words(bytes: Bytes64, length: U32) -> Words16:
  build_result(I.repeat(WordBuild, build_word_step, 16n,
    WordBuild{bytes, length, words16_zero(), 0}))

def pick_word(left: U32, right: U32, choose_left: Bool) -> U32:
  match choose_left:
    case True{}:
      left
    case False{}:
      right

# Binary selection over the 64 standard FIPS 180-4 round constants. The table
# is source data; it does not call a foreign function or hide a hash operation.

def round_constant(+index: U32) -> U32:
  pick_word(
    pick_word(
      pick_word(
        pick_word(
          pick_word(
            pick_word(
              1116352408,
              1899447441,
              U32.is_lt(index, 1)),
            pick_word(
              3049323471,
              3921009573,
              U32.is_lt(index, 3)),
            U32.is_lt(index, 2)),
          pick_word(
            pick_word(
              961987163,
              1508970993,
              U32.is_lt(index, 5)),
            pick_word(
              2453635748,
              2870763221,
              U32.is_lt(index, 7)),
            U32.is_lt(index, 6)),
          U32.is_lt(index, 4)),
        pick_word(
          pick_word(
            pick_word(
              3624381080,
              310598401,
              U32.is_lt(index, 9)),
            pick_word(
              607225278,
              1426881987,
              U32.is_lt(index, 11)),
            U32.is_lt(index, 10)),
          pick_word(
            pick_word(
              1925078388,
              2162078206,
              U32.is_lt(index, 13)),
            pick_word(
              2614888103,
              3248222580,
              U32.is_lt(index, 15)),
            U32.is_lt(index, 14)),
          U32.is_lt(index, 12)),
        U32.is_lt(index, 8)),
      pick_word(
        pick_word(
          pick_word(
            pick_word(
              3835390401,
              4022224774,
              U32.is_lt(index, 17)),
            pick_word(
              264347078,
              604807628,
              U32.is_lt(index, 19)),
            U32.is_lt(index, 18)),
          pick_word(
            pick_word(
              770255983,
              1249150122,
              U32.is_lt(index, 21)),
            pick_word(
              1555081692,
              1996064986,
              U32.is_lt(index, 23)),
            U32.is_lt(index, 22)),
          U32.is_lt(index, 20)),
        pick_word(
          pick_word(
            pick_word(
              2554220882,
              2821834349,
              U32.is_lt(index, 25)),
            pick_word(
              2952996808,
              3210313671,
              U32.is_lt(index, 27)),
            U32.is_lt(index, 26)),
          pick_word(
            pick_word(
              3336571891,
              3584528711,
              U32.is_lt(index, 29)),
            pick_word(
              113926993,
              338241895,
              U32.is_lt(index, 31)),
            U32.is_lt(index, 30)),
          U32.is_lt(index, 28)),
        U32.is_lt(index, 24)),
      U32.is_lt(index, 16)),
    pick_word(
      pick_word(
        pick_word(
          pick_word(
            pick_word(
              666307205,
              773529912,
              U32.is_lt(index, 33)),
            pick_word(
              1294757372,
              1396182291,
              U32.is_lt(index, 35)),
            U32.is_lt(index, 34)),
          pick_word(
            pick_word(
              1695183700,
              1986661051,
              U32.is_lt(index, 37)),
            pick_word(
              2177026350,
              2456956037,
              U32.is_lt(index, 39)),
            U32.is_lt(index, 38)),
          U32.is_lt(index, 36)),
        pick_word(
          pick_word(
            pick_word(
              2730485921,
              2820302411,
              U32.is_lt(index, 41)),
            pick_word(
              3259730800,
              3345764771,
              U32.is_lt(index, 43)),
            U32.is_lt(index, 42)),
          pick_word(
            pick_word(
              3516065817,
              3600352804,
              U32.is_lt(index, 45)),
            pick_word(
              4094571909,
              275423344,
              U32.is_lt(index, 47)),
            U32.is_lt(index, 46)),
          U32.is_lt(index, 44)),
        U32.is_lt(index, 40)),
      pick_word(
        pick_word(
          pick_word(
            pick_word(
              430227734,
              506948616,
              U32.is_lt(index, 49)),
            pick_word(
              659060556,
              883997877,
              U32.is_lt(index, 51)),
            U32.is_lt(index, 50)),
          pick_word(
            pick_word(
              958139571,
              1322822218,
              U32.is_lt(index, 53)),
            pick_word(
              1537002063,
              1747873779,
              U32.is_lt(index, 55)),
            U32.is_lt(index, 54)),
          U32.is_lt(index, 52)),
        pick_word(
          pick_word(
            pick_word(
              1955562222,
              2024104815,
              U32.is_lt(index, 57)),
            pick_word(
              2227730452,
              2361852424,
              U32.is_lt(index, 59)),
            U32.is_lt(index, 58)),
          pick_word(
            pick_word(
              2428436474,
              2756734187,
              U32.is_lt(index, 61)),
            pick_word(
              3204031479,
              3329325298,
              U32.is_lt(index, 63)),
            U32.is_lt(index, 62)),
          U32.is_lt(index, 60)),
        U32.is_lt(index, 56)),
      U32.is_lt(index, 48)),
    U32.is_lt(index, 32))

def shift_right(count: Nat, value: U32) -> U32:
  I.repeat(U32, U32.shr, count, value)

def rotate_right(count: Nat, mask: U32, multiplier: U32,
    +value: U32) -> U32:
  +high = shift_right(count, value)
  +low = U32.mul(U32.and(value, mask), multiplier)
  U32.or(high, low)

def rotate2(value: U32) -> U32:
  rotate_right(2n, 3, 1073741824, value)

def rotate6(value: U32) -> U32:
  rotate_right(6n, 63, 67108864, value)

def rotate7(value: U32) -> U32:
  rotate_right(7n, 127, 33554432, value)

def rotate11(value: U32) -> U32:
  rotate_right(11n, 2047, 2097152, value)

def rotate13(value: U32) -> U32:
  rotate_right(13n, 8191, 524288, value)

def rotate17(value: U32) -> U32:
  rotate_right(17n, 131071, 32768, value)

def rotate18(value: U32) -> U32:
  rotate_right(18n, 262143, 16384, value)

def rotate19(value: U32) -> U32:
  rotate_right(19n, 524287, 8192, value)

def rotate22(value: U32) -> U32:
  rotate_right(22n, 4194303, 1024, value)

def rotate25(value: U32) -> U32:
  rotate_right(25n, 33554431, 128, value)

def choose(+x: U32, y: U32, z: U32) -> U32:
  U32.xor(U32.and(x, y), U32.and(U32.not(x), z))

def majority(+a: U32, +b: U32, +c: U32) -> U32:
  U32.xor(U32.xor(U32.and(a, b), U32.and(a, c)), U32.and(b, c))

def big_sigma0(+value: U32) -> U32:
  U32.xor(U32.xor(rotate2(value), rotate13(value)), rotate22(value))

def big_sigma1(+value: U32) -> U32:
  U32.xor(U32.xor(rotate6(value), rotate11(value)), rotate25(value))

def small_sigma0(+value: U32) -> U32:
  U32.xor(U32.xor(rotate7(value), rotate18(value)), shift_right(3n, value))

def small_sigma1(+value: U32) -> U32:
  U32.xor(U32.xor(rotate17(value), rotate19(value)), shift_right(10n, value))

def prepare_word_checked(initial: Bool, +words: Words16, +index: U32) -> SelectedWord:
  match initial:
    case True{}:
      SelectedWord{words, words16_get(words, index)}
    case False{}:
      +w15 = words16_get(words, U32.mod(U32.add(index, 1), 16))
      +w2 = words16_get(words, U32.mod(U32.add(index, 14), 16))
      +w16 = words16_get(words, U32.mod(index, 16))
      w7 = words16_get(words, U32.mod(U32.add(index, 9), 16))
      +expanded = U32.add(U32.add(small_sigma1(w2), w7),
        U32.add(w16, small_sigma0(w15)))
      +updated = words16_set(words, U32.mod(index, 16), expanded)
      SelectedWord{updated, expanded}

def prepare_word(+words: Words16, +index: U32) -> SelectedWord:
  prepare_word_checked(U32.is_lt(index, 16), words, index)

def round_apply(input: RoundInput) -> RoundState:
  match input:
    case RoundInput{selected, +index, +a, +b, +c, d, +e, +f, +g, h}:
      match selected:
        case SelectedWord{words, w}:
          +s1 = big_sigma1(e)
          +ch = choose(e, f, g)
          +k = round_constant(index)
          +t1a = U32.add(h, s1)
          +t1b = U32.add(t1a, ch)
          +t1c = U32.add(t1b, k)
          +t1 = U32.add(t1c, w)
          +t2 = U32.add(big_sigma0(a), majority(a, b, c))
          RoundState{words, U32.add(index, 1), U32.add(t1, t2), a, b, c,
            U32.add(d, t1), e, f, g}

def round_step(state: RoundState) -> RoundState:
  match state:
    case RoundState{+words, +index, +a, +b, +c, d, +e, +f, +g, h}:
      round_apply(RoundInput{prepare_word(words, index), index, a, b, c, d,
        e, f, g, h})

def compress_result(finished: RoundState) -> Digest256:
  match finished:
    case RoundState{words, index, a, b, c, d, e, f, g, h}:
      Digest256{U32.add(1779033703, a), U32.add(3144134277, b),
        U32.add(1013904242, c), U32.add(2773480762, d),
        U32.add(1359893119, e), U32.add(2600822924, f),
        U32.add(528734635, g), U32.add(1541459225, h)}

def compress(bytes: Bytes64, length: U32) -> Digest256:
  +schedule = initial_words(bytes, length)
  compress_result(I.repeat(RoundState, round_step, 64n,
    RoundState{schedule, 0, 1779033703, 3144134277, 1013904242,
      2773480762, 1359893119, 2600822924, 528734635, 1541459225}))

def hash_short_byte_check(bytes_valid: Bool, bytes: Bytes64,
    length: U32) -> HashResult:
  match bytes_valid:
    case False{}:
      Rejected{}
    case True{}:
      Hashed{compress(bytes, length)}

def hash_short_length_check(is_short: Bool, +length: U32,
    +bytes: Bytes64) -> HashResult:
  match is_short:
    case False{}:
      Rejected{}
    case True{}:
      hash_short_byte_check(active_bytes_valid(bytes, length), bytes, length)

def hash_short(message: Message) -> HashResult:
  match message:
    case Message{+length, +bytes}:
      hash_short_length_check(short_length(length), length, bytes)
