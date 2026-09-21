import ./vault.bend as Vault
import ../../sdk/context.bend as Sol
import ../../sdk/math.bend as Math

law unauthorized:
  for outcome: Vault.Outcome
  {Vault.authorize(False{}, outcome) == Vault.Rejected{1} : Vault.Outcome}

law unsigned_live:
  for actor: Sol.Key
  for owner: Sol.Key
  for mint: Sol.Key
  for balance: Math.U64
  for slot: Math.U64
  for instruction: Vault.Instruction
  {Vault.process(Sol.Context{actor, False{}, slot}, Vault.Live{owner, mint, balance}, instruction) == Vault.Rejected{1} : Vault.Outcome}

law unsigned_initialize:
  for actor: Sol.Key
  for mint: Sol.Key
  for slot: Math.U64
  {Vault.process(Sol.Context{actor, False{}, slot}, Vault.Empty{}, Vault.Initialize{mint}) == Vault.Rejected{1} : Vault.Outcome}

law rejected_deposit:
  for owner: Sol.Key
  for mint: Sol.Key
  for amount: Math.U64
  for code: U32
  {Vault.deposited(owner, mint, amount, Math.Err{code}) == Vault.Rejected{4} : Vault.Outcome}

law rejected_withdrawal:
  for owner: Sol.Key
  for mint: Sol.Key
  for amount: Math.U64
  for code: U32
  {Vault.withdrawn(owner, mint, amount, Math.Err{code}) == Vault.Rejected{5} : Vault.Outcome}
