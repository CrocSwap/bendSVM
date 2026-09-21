import ./queue.bend as Q
import ../../sdk/collection.bend as C
import ../../sdk/buffer.bend as B
import ../../sdk/issuance.bend as Fx
import ../../sdk/math.bend as M

law closed_is_terminal:
  for context: C.Context
  for instruction: Q.Instruction
  for metadata: C.Metadata
  for window: C.Window<Q.Obligation, B.Pair<Q.Obligation>>
  {Q.process(context, Q.Closed{}, instruction, metadata, window) == Q.Rejected{2} : Q.Outcome}

law unauthorized_is_rejected:
  for phase: Bool
  for queue: Q.Queue
  for instruction: Q.Instruction
  for metadata: C.Metadata
  for window: C.Window<Q.Obligation, B.Pair<Q.Obligation>>
  {Q.authorized(False{}, phase, queue, instruction, metadata, window) == Q.Rejected{1} : Q.Outcome}

law invalid_append_is_rejected:
  for queue: Q.Queue
  for obligation: Q.Obligation
  for window: C.Window<Q.Obligation, B.Pair<Q.Obligation>>
  {Q.append_checked(False{}, queue, obligation, window) == Q.Rejected{3} : Q.Outcome}

law invalid_fold_is_rejected:
  for queue: Q.Queue
  for page: U32
  for window: C.Window<Q.Obligation, B.Pair<Q.Obligation>>
  {Q.folded(queue, page, window, B.Invalid{}) == Q.Rejected{5} : Q.Outcome}

law conservation_is_required:
  for state: Q.State
  for window: C.Window<Q.Obligation, B.Pair<Q.Obligation>>
  for length: U32
  for effects: B.Vector<Fx.Effect, B.Pair<Fx.Effect>>
  {Q.finish_page(False{}, state, window, length, effects) == Q.Rejected{6} : Q.Outcome}

law arithmetic_error_persists:
  for amount: M.U64
  for code: U32
  {Q.deduct(amount, M.Err{code}) == M.Err{code} : M.Checked}
