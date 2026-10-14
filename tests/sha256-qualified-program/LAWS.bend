import ../../sdk/sha256-reference.bend as SHA

law accepts_last_short_length:
  {SHA.short_length(55) == True{} : Bool}

law rejects_first_long_length:
  {SHA.short_length(56) == False{} : Bool}

law accepts_last_byte_value:
  {SHA.byte_value(255) == True{} : Bool}

law rejects_first_non_byte_value:
  {SHA.byte_value(256) == False{} : Bool}

law rejects_length_56:
  for bytes: SHA.Bytes64
  {SHA.hash_short(SHA.Message{56, bytes}) == SHA.Rejected{} : SHA.HashResult}

law rejects_u32_max_length:
  for bytes: SHA.Bytes64
  {SHA.hash_short(SHA.Message{4294967295, bytes}) == SHA.Rejected{} : SHA.HashResult}
