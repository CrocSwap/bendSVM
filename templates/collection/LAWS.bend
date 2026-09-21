import ./program.bend as Program
import @SDK@/collection.bend as C
import @SDK@/buffer.bend as B
import @SDK@/context.bend as Sol
import @SDK@/math.bend as M

law unauthorized:
  for state: Program.State
  for instruction: Program.Instruction
  for length: U32
  for window: C.Window<U32, B.Pair<U32>>
  {Program.dispatch(False{}, state, instruction, length, window) == Program.Rejected{1} : Program.Outcome}

law initialization_requires_signature:
  for actor: Sol.Key
  for slot: M.U64
  for collection: Sol.Key
  for window: C.Window<U32, B.Pair<U32>>
  {Program.initialize(C.Context{actor, False{}, slot, collection}, window, 0) == Program.Rejected{1} : Program.Outcome}

law invalid_update_preserves_rejection:
  for state: Program.State
  for length: U32
  {Program.finish(state, B.Invalid{}, length) == Program.Rejected{3} : Program.Outcome}
