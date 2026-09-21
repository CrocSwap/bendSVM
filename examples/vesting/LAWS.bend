import ./vesting.bend as Vest
import ../../sdk/context.bend as Sol
import ../../sdk/math.bend as Math

law invalid_schedule:
  for beneficiary: Sol.Key
  for mint: Sol.Key
  for total: Math.U64
  for start: Math.U64
  for end: Math.U64
  {Vest.initialize(False{}, beneficiary, mint, total, start, end) == Vest.Rejected{3} : Vest.Outcome}

law over_entitlement:
  for schedule: Vest.Schedule
  for vested: Math.U64
  {Vest.bounded(True{}, schedule, vested) == Vest.Rejected{4} : Vest.Outcome}

law no_payout:
  for schedule: Vest.Schedule
  for amount: Math.U64
  {Vest.payout(False{}, schedule, amount) == Vest.Rejected{6} : Vest.Outcome}

law unsigned_claim:
  for actor: Sol.Key
  for beneficiary: Sol.Key
  for mint: Sol.Key
  for total: Math.U64
  for start: Math.U64
  for end: Math.U64
  for claimed: Math.U64
  for slot: Math.U64
  {Vest.process(Sol.Context{actor, False{}, slot}, Vest.Live{Vest.Schedule{beneficiary, mint, total, start, end, claimed}}, Vest.Claim{}) == Vest.Rejected{1} : Vest.Outcome}
