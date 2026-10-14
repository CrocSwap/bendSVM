import ../../sdk/sha256-packed.bend as H
import ../../sdk/sha256-reference.bend as S

law accepts_last_length:
  {H.length_valid(151) == True{} : Bool}

law rejects_next_length:
  {H.length_valid(152) == False{} : Bool}

law rejects_long_message:
  for bytes: H.Bytes160
  {H.hash_bounded(H.Message{152, bytes}) == S.Rejected{} : S.HashResult}

law first_padding_boundary:
  {H.block_count(56) == 2 : U32}

law second_padding_boundary:
  {H.block_count(120) == 3 : U32}
