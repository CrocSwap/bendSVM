import Base
import ./common.bend as Dcg

def start(+total: U32) -> Dcg.EligibleWinnerFold:
  Dcg.EligibleWinnerFold{total, 0, True{}, False{}, 0,
    Dcg.Key32{0, 0, 0, 0, 0, 0, 0, 0}, U32.is_ge(1024, total)}

def ruled(state: Dcg.OutcomeState) -> Bool:
  match state:
    case Dcg.Ruled{}:
      True{}
    case Dcg.Settled{}:
      True{}
    case _:
      False{}

def challenger(winner: Dcg.Winner) -> Bool:
  match winner:
    case Dcg.Challenger{}:
      True{}
    case _:
      False{}

def used(state: Dcg.OutcomeState) -> Bool:
  match state:
    case Dcg.Unused{}:
      False{}
    case _:
      True{}

def key_if(condition: Bool, yes: Dcg.Key32, no: Dcg.Key32) -> Dcg.Key32:
  match condition:
    case True{}:
      yes
    case False{}:
      no

def sequence_if(condition: Bool, yes: U32, no: U32) -> U32:
  match condition:
    case True{}:
      yes
    case False{}:
      no

def apply(total: U32, +next: U32, +prefix: Bool, +found: Bool,
    sequence: U32, key: Dcg.Key32, row: Dcg.RulingScanCell,
    can_step: Bool) -> Dcg.EligibleWinnerFold:
  match row can_step:
    case Dcg.RulingScanCell{+state, +winner, row_key} True{}:
      +this_ruled = ruled(state)
      +take = Bool.and(Bool.not(found), Bool.and(prefix,
        Bool.and(this_ruled, challenger(winner))))
      Dcg.EligibleWinnerFold{total, U32.add(next, 1),
        Bool.and(prefix, this_ruled), Bool.or(found, take),
        sequence_if(take, next, sequence), key_if(take, row_key, key),
        Bool.and(used(state), Dcg.outcome_consistent(state, winner))}
    case Dcg.RulingScanCell{_, _, _} False{}:
      Dcg.EligibleWinnerFold{total, next, prefix, found, sequence, key, False{}}

def step(input: Dcg.EligibleWinnerStep) -> Dcg.EligibleWinnerFold:
  match input:
    case Dcg.EligibleWinnerStep{fold, row}:
      match fold:
        case Dcg.EligibleWinnerFold{+total, +next, prefix, found, sequence, key, valid}:
          apply(total, next, prefix, found, sequence, key, row,
            Bool.and(valid, Bool.and(U32.is_ge(1024, total), U32.is_lt(next, total))))
