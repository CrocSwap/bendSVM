import ./LAWS.bend as Laws
import ../../sdk/sha256-reference.bend as SHA

def hash_short(message: SHA.Message) -> SHA.HashResult:
  SHA.hash_short(message)

def Laws.accepts_last_short_length():
  {==}

def Laws.rejects_first_long_length():
  {==}

def Laws.accepts_last_byte_value():
  {==}

def Laws.rejects_first_non_byte_value():
  {==}

def Laws.rejects_length_56(bytes):
  {==}

def Laws.rejects_u32_max_length(bytes):
  {==}
