import Base
import ./common.bend as Dcg

type Facts131 is Data:
  Facts131{
    abi_version: U32,
    instruction_descriptor: Dcg.Key32,
    now_slot: Dcg.U64,
    roles: Dcg.Roles131,
    response_kind: Dcg.ResponseKind131,
    challenge: Dcg.Dcr1Fact,
    document: Dcg.Dcm2Fact,
    policy_facts: Dcg.DpaHeader,
    selected_row: Dcg.SelectedOutcome,
    policy_destination_key: Dcg.Key32,
    fold: Dcg.WinnerFold
  }

type Plan131 is Data:
  Plan131{
    sequence: Dcg.U64,
    dcr1_close: Bool,
    response_close: Bool,
    dpa1_row_state_after: Dcg.OutcomeState,
    dpa1_settlement_slot: Dcg.U64,
    dpa1_first_winner_sequence_after: Dcg.U64,
    dpa1_first_winner_key_after: Dcg.Key32,
    dcm2_open_challenges_after: U32,
    dcm2_first_winner_key_after: Dcg.Key32,
    dcm2_bond_state_after: U32,
    document_pot_action: Dcg.PotDisposition,
    dpa1_payout_state_after: Dcg.DpaState,
    escrow_update: Dcg.EscrowUpdate,
    transfers: Dcg.Transfers8
  }

def identity_facts(facts: Facts131) -> Facts131:
  facts

def identity_plan(plan: Plan131) -> Plan131:
  plan

def start_fold131(+target_sequence: U32) -> Dcg.WinnerFold:
  Dcg.WinnerFold{target_sequence, 0, 0, False{}, 0,
    Dcg.Key32{0, 0, 0, 0, 0, 0, 0, 0}, U32.is_ge(1024, target_sequence)}

def ruled_challenger(state: Dcg.OutcomeState, winner: Dcg.Winner) -> Bool:
  match state winner:
    case Dcg.Ruled{} Dcg.Challenger{}:
      True{}
    case Dcg.Settled{} Dcg.Challenger{}:
      True{}
    case _ _:
      False{}

def is_open(state: Dcg.OutcomeState) -> Bool:
  match state:
    case Dcg.Open{}:
      True{}
    case _:
      False{}

def is_unused(state: Dcg.OutcomeState) -> Bool:
  match state:
    case Dcg.Unused{}:
      True{}
    case _:
      False{}

def choose_key(condition: Bool, yes: Dcg.Key32, no: Dcg.Key32) -> Dcg.Key32:
  match condition:
    case True{}:
      yes
    case False{}:
      no

def choose_sequence(condition: Bool, yes: U32, no: U32) -> U32:
  match condition:
    case True{}:
      yes
    case False{}:
      no

def fold131_step_checked(target: U32, +next: U32, +open_rows: U32,
    +has_winner: Bool, first_sequence: U32, first_key: Dcg.Key32,
    row: Dcg.OutcomeEvidenceCell, can_step: Bool) -> Dcg.WinnerFold:
  match row can_step:
    case Dcg.OutcomeEvidenceCell{+state, +winner, _, _, _, _, _, challenger_key} True{}:
      +is_challenger_win = ruled_challenger(state, winner)
      +take_first = Bool.and(Bool.not(has_winner), is_challenger_win)
      +next_key = choose_key(take_first, challenger_key, first_key)
      +next_winner_sequence = choose_sequence(take_first, next, first_sequence)
      Dcg.WinnerFold{target, U32.add(next, 1),
        U32.add(open_rows, Bool.to_u32(is_open(state))),
        Bool.or(has_winner, is_challenger_win), next_winner_sequence, next_key,
        Bool.and(Bool.not(is_unused(state)), Dcg.outcome_consistent(state, winner))}
    case Dcg.OutcomeEvidenceCell{_, _, _, _, _, _, _, _} False{}:
      Dcg.WinnerFold{target, next, open_rows, has_winner, first_sequence, first_key, False{}}

def fold131_step(step: Dcg.FoldStep131) -> Dcg.WinnerFold:
  match step:
    case Dcg.FoldStep131{fold, row}:
      match fold:
        case Dcg.WinnerFold{+target, +next, +open_rows, +has_winner,
            first_sequence, first_key, valid}:
          fold131_step_checked(target, next, open_rows, has_winner,
            first_sequence, first_key, row,
            Bool.and(valid, Bool.and(U32.is_ge(1024, target),
              Bool.and(U32.is_ge(next, open_rows), U32.is_lt(next, target)))))
