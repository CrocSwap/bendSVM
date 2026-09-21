import ./batch.bend as Batch
import ../../sdk/context.bend as Sol
import ../../sdk/math.bend as Math
import ../../sdk/buffer.bend as B
import ../../sdk/issuance.bend as Fx

law closed_is_terminal:
  for context: Sol.Context
  for instruction: Batch.Instruction
  {Batch.process(context, Batch.Closed{}, instruction) == Batch.Rejected{2} : Batch.Outcome}

law invalid_initial_fold:
  for batch: Batch.Batch
  {Batch.initialize_fold(batch, B.Invalid{}) == Batch.Rejected{3} : Batch.Outcome}

law invalid_settlement_fold:
  for total: Math.U64
  {Batch.settle_fold(total, B.Invalid{}) == Batch.Rejected{5} : Batch.Outcome}

law conservation_required:
  for effects: B.Vector<Fx.Effect, B.Pair<B.Pair<Fx.Effect>>>
  {Batch.conserved(False{}, effects) == Batch.Rejected{6} : Batch.Outcome}

law sum_error_is_preserved:
  for code: U32
  for amount: Math.U64
  {Batch.add_amount(Math.Err{code}, amount) == Math.Err{code} : Math.Checked}

law unsigned_initialization:
  for owner: Sol.Key
  for mint: Sol.Key
  for vault: Sol.Key
  for obligations: B.Vector<Batch.Obligation, B.Pair<B.Pair<Batch.Obligation>>>
  for fuel: Nat
  {Batch.initialize(False{}, owner, mint, vault, obligations, fuel) == Batch.Rejected{1} : Batch.Outcome}
