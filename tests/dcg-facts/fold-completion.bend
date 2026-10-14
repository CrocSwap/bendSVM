import Base
import ./common.bend as Dcg

# These consistency checks do not authenticate their inputs or implement a
# handler. A future core must construct bindings from validated facts and use
# only a private Bend-initialized/stepped accumulator.
type TableBinding is Data:
  TableBinding{next: Dcg.U64, capacity: U32, committed_limit: U32}

type LedgerCompletion is Data:
  LedgerCompletion{table: TableBinding, fold: Dcg.LedgerFold}

type WinnerCompletion is Data:
  WinnerCompletion{table: TableBinding, fold: Dcg.EligibleWinnerFold}

type PriorCompletion is Data:
  PriorCompletion{
    table: TableBinding,
    document_next: Dcg.U64,
    challenge_sequence: Dcg.U64,
    selected_sequence: Dcg.U64,
    fold: Dcg.WinnerFold
  }

def table_valid(next: U32, high: U32, +capacity: U32, limit: U32) -> Bool:
  Bool.and(U32.is_zero(high), Bool.and(U32.is_eq(capacity, limit),
    Bool.and(U32.is_lt(0, capacity),
      Bool.and(U32.is_ge(1024, capacity), U32.is_ge(capacity, next)))))

def winner_index_valid(found: Bool, sequence: U32, total: U32) -> Bool:
  Bool.or(Bool.not(found), U32.is_lt(sequence, total))

def ledger_complete(input: LedgerCompletion) -> Bool:
  match input:
    case LedgerCompletion{table, fold}:
      match table fold:
        case TableBinding{Dcg.U64{+next, high}, capacity, limit}
            Dcg.LedgerFold{total, cursor, unsettled, valid}:
          Bool.and(table_valid(next, high, capacity, limit),
            Bool.and(valid, Bool.and(U32.is_eq(total, next),
              Bool.and(U32.is_eq(cursor, next), U32.is_zero(unsettled)))))

def winner_complete(input: WinnerCompletion) -> Bool:
  match input:
    case WinnerCompletion{table, fold}:
      match table fold:
        case TableBinding{Dcg.U64{+next, high}, capacity, limit}
            Dcg.EligibleWinnerFold{total, cursor, _, found, sequence, _, valid}:
          Bool.and(table_valid(next, high, capacity, limit),
            Bool.and(valid, Bool.and(U32.is_eq(total, next),
              Bool.and(U32.is_eq(cursor, next), winner_index_valid(found, sequence, next)))))

def prior_complete(input: PriorCompletion) -> Bool:
  match input:
    case PriorCompletion{table, document_next, challenge_sequence, selected_sequence, fold}:
      match table document_next challenge_sequence selected_sequence fold:
        case TableBinding{Dcg.U64{+next, high}, capacity, limit}
            Dcg.U64{doc_next, doc_high} Dcg.U64{+challenge, challenge_high}
            Dcg.U64{selected, selected_high}
            Dcg.WinnerFold{+target, cursor, open_rows, found, first_sequence, _, valid}:
          +table_bound = Bool.and(table_valid(next, high, capacity, limit),
            Bool.and(U32.is_eq(doc_next, next), U32.is_zero(doc_high)))
          +target_bound = Bool.and(U32.is_eq(target, challenge),
            Bool.and(U32.is_eq(target, selected),
              Bool.and(U32.is_zero(challenge_high), U32.is_zero(selected_high))))
          Bool.and(table_bound, Bool.and(target_bound,
            Bool.and(valid, Bool.and(U32.is_lt(target, next),
              Bool.and(U32.is_eq(cursor, target), Bool.and(U32.is_zero(open_rows),
                winner_index_valid(found, first_sequence, target)))))))
