import ../../sdk/context.bend as Sol
import ../../sdk/sha256-reference.bend as SHA

type Outcome is Data:
  Accepted{state: SHA.HashResult}
  Rejected{code: U32}

def process(context: Sol.Context, state: SHA.HashResult, message: SHA.Message) -> Outcome:
  Accepted{SHA.hash_short(message)}
