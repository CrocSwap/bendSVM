import ./amm.bend as Amm
import ../../sdk/context.bend as Sol
import ./pricing.bend as Price
import ../../sdk/math.bend as Math

# These local rejection laws are checked by Bend. They are not a proof of
# economic invariants; the milestone also requires checked-source SMT proofs.
law invalid_swap:
  for input: Math.U64
  for output: Math.U64
  for gross: Math.U64
  {Price.swap_valid(False{}, input, output, gross) == Math.Err{4} : Math.Checked}

law invalid_deposit:
  for reserve: Math.U64
  for shares: Math.U64
  for supply: Math.U64
  {Price.deposit_valid(False{}, reserve, shares, supply) == Math.Err{4} : Math.Checked}

law invalid_withdrawal:
  for reserve: Math.U64
  for shares: Math.U64
  for supply: Math.U64
  {Price.withdraw_valid(False{}, reserve, shares, supply) == Math.Err{4} : Math.Checked}

law failed_capacity:
  for input: Math.U64
  for output: Math.U64
  for gross: Math.U64
  {Price.output_with_capacity(input, output, gross, Math.Err{1}) == Math.Err{1} : Math.Checked}


law unsigned_pool:
  for actor: Sol.Key
  for slot: Math.U64
  for state: Amm.State
  for instruction: Amm.Instruction
  {Amm.process(Sol.Context{actor, False{}, slot}, state, instruction) == Amm.Rejected{1} : Amm.Outcome}

law repeated_initialization:
  for pool: Amm.Pool
  for config: Amm.Config
  for base: Math.U64
  for quote: Math.U64
  for minimum: Math.U64
  {Amm.dispatch(Amm.Open{pool}, Amm.Initialize{config, base, quote, minimum}) == Amm.Rejected{2} : Amm.Outcome}

law failed_guard:
  for code: U32
  for outcome: Amm.Outcome
  {Amm.guard(False{}, code, outcome) == Amm.Rejected{code} : Amm.Outcome}
