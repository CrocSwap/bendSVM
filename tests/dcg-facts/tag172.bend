import Base
import ./common.bend as Dcg


def start_ledger_fold172(+total: U32) -> Dcg.LedgerFold:
  Dcg.LedgerFold{total, 0, 0, U32.is_ge(1024, total)}

def is_settled(state: Dcg.OutcomeState) -> Bool:
  match state:
    case Dcg.Settled{}:
      True{}
    case _:
      False{}

def apply_ledger_cell(fold: Dcg.LedgerFold, cell: Dcg.SettledWindowCell,
    active: Bool) -> Dcg.LedgerFold:
  match fold cell active:
    case Dcg.LedgerFold{total, +next, +unsettled, valid}
        Dcg.SettledWindowCell{state} True{}:
      Dcg.LedgerFold{total, U32.add(next, 1),
        U32.add(unsettled, Bool.to_u32(Bool.not(is_settled(state)))), valid}
    case Dcg.LedgerFold{total, next, unsettled, valid}
        Dcg.SettledWindowCell{_} False{}:
      Dcg.LedgerFold{total, next, unsettled, valid}

def invalidate_ledger_fold(fold: Dcg.LedgerFold) -> Dcg.LedgerFold:
  match fold:
    case Dcg.LedgerFold{total, next, unsettled, _}:
      Dcg.LedgerFold{total, next, unsettled, False{}}

def fold_ledger_window_checked(+fold: Dcg.LedgerFold, window: Dcg.SettledWindow8,
    can_step: Bool) -> Dcg.LedgerFold:
  match fold:
    case Dcg.LedgerFold{total, next, unsettled, valid}:
      match window:
        case Dcg.SettledWindow8{meta, c0, c1, c2, c3, c4, c5, c6, c7}:
          match meta:
            case Dcg.WindowMeta8{+count}:
              match can_step:
                case True{}:
                  +f1 = apply_ledger_cell(Dcg.LedgerFold{total, next, unsettled, valid}, c0, U32.is_lt(0, count))
                  +f2 = apply_ledger_cell(f1, c1, U32.is_lt(1, count))
                  +f3 = apply_ledger_cell(f2, c2, U32.is_lt(2, count))
                  +f4 = apply_ledger_cell(f3, c3, U32.is_lt(3, count))
                  +f5 = apply_ledger_cell(f4, c4, U32.is_lt(4, count))
                  +f6 = apply_ledger_cell(f5, c5, U32.is_lt(5, count))
                  +f7 = apply_ledger_cell(f6, c6, U32.is_lt(6, count))
                  apply_ledger_cell(f7, c7, U32.is_lt(7, count))
                case False{}:
                  Dcg.LedgerFold{total, next, unsettled, False{}}

def fold_ledger_window(fold: Dcg.LedgerFold, window: Dcg.SettledWindow8) -> Dcg.LedgerFold:
  match fold window:
    case Dcg.LedgerFold{+total, +next, +unsettled, +valid}
        Dcg.SettledWindow8{meta, c0, c1, c2, c3, c4, c5, c6, c7}:
      match meta:
        case Dcg.WindowMeta8{+count}:
          +count_valid = Bool.and(U32.is_lt(0, count), U32.is_ge(8, count))
          +range_valid = Bool.and(U32.is_ge(total, next), U32.is_ge(U32.sub(total, next), count))
          +can_step = Bool.and(valid, Bool.and(U32.is_ge(1024, total),
            Bool.and(U32.is_ge(next, unsettled), Bool.and(count_valid, range_valid))))
          fold_ledger_window_checked(Dcg.LedgerFold{total, next, unsettled, valid},
            Dcg.SettledWindow8{Dcg.WindowMeta8{count}, c0, c1, c2, c3, c4, c5, c6, c7}, can_step)

def fold172_ledger_step(step: Dcg.LedgerFoldStep172) -> Dcg.LedgerFold:
  match step:
    case Dcg.LedgerFoldStep172{fold, window}:
      fold_ledger_window(fold, window)

def completion_span_after_first(first_output_position: U32, last_position: U32,
    covers_first: Bool) -> U32:
  match covers_first:
    case True{}:
      U32.sub(last_position, first_output_position)
    case False{}:
      0

def completion_span(+first_output_position: U32, landed_positions: U32,
    no_positions: Bool) -> U32:
  match no_positions:
    case True{}:
      0
    case False{}:
      +last_position = U32.sub(landed_positions, 1)
      completion_span_after_first(first_output_position, last_position,
        U32.is_ge(last_position, first_output_position))

def result_span_mode(first_output_position: U32, option_count: U32,
    +landed_positions: U32, decision_mode: Bool) -> U32:
  match decision_mode:
    case True{}:
      U32.add(1, option_count)
    case False{}:
      +no_positions = U32.is_zero(landed_positions)
      completion_span(first_output_position, landed_positions, no_positions)

def result_span(binding: Dcg.Drb1Binding, landed_positions: U32) -> U32:
  match binding:
    case Dcg.Drb1Binding{first, _, _, _, _, flags, options, _, _, _}:
      result_span_mode(first, options, landed_positions,
        Bool.not(U32.is_zero(U32.and(flags, 1))))

def stop_shape(output_width: U32,
    decision_mode: Bool, stop_disabled: Bool) -> Bool:
  match stop_disabled:
    case True{}:
      True{}
    case False{}:
      Bool.and(U32.is_eq(output_width, 16), Bool.not(decision_mode))

def start_result_fold172(config: Dcg.ResultFoldStart172) -> Dcg.ResultFold:
  match config:
    case Dcg.ResultFoldStart172{binding, landed_positions, +output_count, +output_width,
        +result_status}:
      match binding:
        case Dcg.Drb1Binding{first, binding_count, _, _, binding_width, flags,
            options, _, +stop_plus_one, _}:
          +decision_mode = Bool.not(U32.is_zero(U32.and(flags, 1)))
          +prefix_length = result_span_mode(first, options, landed_positions, decision_mode)
          +stop_disabled = U32.is_zero(stop_plus_one)
          +stop_shape_valid = stop_shape(output_width, decision_mode, stop_disabled)
          +already_final = U32.is_eq(result_status, 1)
          +scan_valid = Bool.and(U32.is_lt(0, prefix_length),
            Bool.and(U32.is_ge(output_count, prefix_length),
              Bool.and(U32.is_eq(output_count, binding_count),
                Bool.and(U32.is_eq(output_width, binding_width),
                  Bool.and(U32.is_lt(0, output_width),
                    Bool.and(U32.is_ge(32, output_width), stop_shape_valid))))))
          +valid = Bool.or(already_final, scan_valid)
          Dcg.ResultFold{output_count, prefix_length, 0, 0, 0, 0, False{},
            stop_plus_one, output_width, decision_mode, already_final, True{}, valid}

def same_bool(left: Bool, right: Bool) -> Bool:
  match left right:
    case True{} True{}:
      True{}
    case False{} False{}:
      True{}
    case _ _:
      False{}

def choose_bool(condition: Bool, yes: Bool, no: Bool) -> Bool:
  match condition:
    case True{}:
      yes
    case False{}:
      no

def is_stop_value_checked(token_low: U32, token_high: U32, stop_plus_one: U32,
    valid_shape: Bool) -> Bool:
  match valid_shape:
    case True{}:
      Bool.and(U32.is_zero(token_high), U32.is_eq(token_low, U32.sub(stop_plus_one, 1)))
    case False{}:
      False{}

def is_stop_value(+value: Dcg.CellBytes32, +stop_plus_one: U32,
    output_width: U32) -> Bool:
  match value:
    case Dcg.CellBytes32{_, _, token_low, token_high, _, _, _, _}:
      is_stop_value_checked(token_low, token_high, stop_plus_one,
        Bool.and(U32.is_eq(output_width, 16), U32.is_lt(0, stop_plus_one)))

def fold_result_cell(fold: Dcg.ResultFold, cell: Dcg.ResultWindowCell,
    +attested: Bool) -> Dcg.ResultFold:
  match fold cell:
    case Dcg.ResultFold{total, +expected, +next, +prefix_count, +after_count,
        +before_count, last_is_stop, +stop_plus_one, +output_width, decision_mode,
        scan_skipped_final, +bitmap_matches, valid} Dcg.ResultWindowCell{value}:
      +in_prefix = U32.is_lt(next, expected)
      +matches_bitmap = same_bool(attested, in_prefix)
      +stop_value = is_stop_value(value, stop_plus_one, output_width)
      +before_last = U32.is_lt(U32.add(next, 1), expected)
      +at_last = U32.is_eq(U32.add(next, 1), expected)
      Dcg.ResultFold{total, expected, U32.add(next, 1),
        U32.add(prefix_count, Bool.to_u32(Bool.and(in_prefix, attested))),
        U32.add(after_count, Bool.to_u32(Bool.and(Bool.not(in_prefix), attested))),
        U32.add(before_count, Bool.to_u32(Bool.and(before_last, stop_value))),
        choose_bool(at_last, stop_value, last_is_stop), stop_plus_one, output_width,
        decision_mode, scan_skipped_final, Bool.and(bitmap_matches, matches_bitmap), valid}

def invalidate_result_fold(fold: Dcg.ResultFold) -> Dcg.ResultFold:
  match fold:
    case Dcg.ResultFold{total, prefix, next, prefix_count, after_count,
        before_count, last_is_stop, stop_plus_one, width, decision_mode,
        scan_skipped_final, bitmap, _}:
      Dcg.ResultFold{total, prefix, next, prefix_count, after_count, before_count,
        last_is_stop, stop_plus_one, width, decision_mode, scan_skipped_final, bitmap, False{}}

def apply_result_cell_if(fold: Dcg.ResultFold, cell: Dcg.ResultWindowCell,
    active: Bool, attested: Bool) -> Dcg.ResultFold:
  match active:
    case True{}:
      fold_result_cell(fold, cell, attested)
    case False{}:
      fold

def fold_result_window_checked(+fold: Dcg.ResultFold, window: Dcg.ResultWindow8,
    can_step: Bool) -> Dcg.ResultFold:
  match fold:
    case Dcg.ResultFold{total, prefix, next, prefix_count, after_count,
        before_count, last_is_stop, stop_plus_one, width, decision_mode,
        scan_skipped_final, bitmap, valid}:
      match window:
        case Dcg.ResultWindow8{meta, c0, c1, c2, c3, c4, c5, c6, c7}:
          match meta:
            case Dcg.ResultWindowMeta8{+count, +attested_mask}:
              match can_step:
                case True{}:
                  +a0 = U32.is_lt(0, count)
                  +a1 = U32.is_lt(1, count)
                  +a2 = U32.is_lt(2, count)
                  +a3 = U32.is_lt(3, count)
                  +a4 = U32.is_lt(4, count)
                  +a5 = U32.is_lt(5, count)
                  +a6 = U32.is_lt(6, count)
                  +a7 = U32.is_lt(7, count)
                  +f1 = apply_result_cell_if(Dcg.ResultFold{total, prefix, next, prefix_count,
                    after_count, before_count, last_is_stop, stop_plus_one, width,
                    decision_mode, scan_skipped_final, bitmap, valid}, c0, a0, Bool.not(U32.is_zero(U32.and(attested_mask, 1))))
                  +f2 = apply_result_cell_if(f1, c1, a1, Bool.not(U32.is_zero(U32.and(attested_mask, 2))))
                  +f3 = apply_result_cell_if(f2, c2, a2, Bool.not(U32.is_zero(U32.and(attested_mask, 4))))
                  +f4 = apply_result_cell_if(f3, c3, a3, Bool.not(U32.is_zero(U32.and(attested_mask, 8))))
                  +f5 = apply_result_cell_if(f4, c4, a4, Bool.not(U32.is_zero(U32.and(attested_mask, 16))))
                  +f6 = apply_result_cell_if(f5, c5, a5, Bool.not(U32.is_zero(U32.and(attested_mask, 32))))
                  +f7 = apply_result_cell_if(f6, c6, a6, Bool.not(U32.is_zero(U32.and(attested_mask, 64))))
                  apply_result_cell_if(f7, c7, a7, Bool.not(U32.is_zero(U32.and(attested_mask, 128))))
                case False{}:
                  Dcg.ResultFold{total, prefix, next, prefix_count, after_count,
                    before_count, last_is_stop, stop_plus_one, width,
                    decision_mode, scan_skipped_final, bitmap, False{}}

# Reject unused bits even in a partial window. The future account bridge must
# feed the raw final bitmap byte, not pre-mask away invalid padding bits.
def mask_fits_count(+count: U32, +mask: U32) -> Bool:
  Bool.and(U32.is_lt(mask, 256),
    Bool.and(Bool.or(U32.is_ge(count, 8), U32.is_lt(mask, 128)),
      Bool.and(Bool.or(U32.is_ge(count, 7), U32.is_lt(mask, 64)),
        Bool.and(Bool.or(U32.is_ge(count, 6), U32.is_lt(mask, 32)),
          Bool.and(Bool.or(U32.is_ge(count, 5), U32.is_lt(mask, 16)),
            Bool.and(Bool.or(U32.is_ge(count, 4), U32.is_lt(mask, 8)),
              Bool.and(Bool.or(U32.is_ge(count, 3), U32.is_lt(mask, 4)),
                Bool.or(U32.is_ge(count, 2), U32.is_lt(mask, 2)))))))))

def fold_result_window(fold: Dcg.ResultFold, window: Dcg.ResultWindow8) -> Dcg.ResultFold:
  match fold window:
    case Dcg.ResultFold{+total, prefix, +next, +prefix_count, +after_count,
        +before_count, last_is_stop, stop_plus_one, width, decision_mode,
        +scan_skipped_final, bitmap, +valid}
        Dcg.ResultWindow8{meta, c0, c1, c2, c3, c4, c5, c6, c7}:
      match meta:
        case Dcg.ResultWindowMeta8{+count, +attested_mask}:
          +count_valid = Bool.and(U32.is_lt(0, count), U32.is_ge(8, count))
          +range_valid = Bool.and(U32.is_ge(total, next), U32.is_ge(U32.sub(total, next), count))
          +counters_valid = Bool.and(U32.is_ge(next, prefix_count),
            Bool.and(U32.is_ge(next, after_count), U32.is_ge(next, before_count)))
          +byte_aligned = Bool.and(U32.is_zero(U32.and(next, 7)),
            Bool.or(U32.is_eq(count, 8), U32.is_eq(count, U32.sub(total, next))))
          +can_step = Bool.and(valid, Bool.and(counters_valid,
            Bool.and(Bool.and(byte_aligned, mask_fits_count(count, attested_mask)),
              Bool.and(Bool.not(scan_skipped_final), Bool.and(count_valid, range_valid)))))
          fold_result_window_checked(Dcg.ResultFold{total, prefix, next, prefix_count,
            after_count, before_count, last_is_stop, stop_plus_one, width,
            decision_mode, scan_skipped_final, bitmap, valid},
            Dcg.ResultWindow8{Dcg.ResultWindowMeta8{count, attested_mask}, c0, c1, c2, c3, c4, c5, c6, c7}, can_step)

def fold172_result_step(step: Dcg.ResultFoldStep172) -> Dcg.ResultFold:
  match step:
    case Dcg.ResultFoldStep172{fold, window}:
      fold_result_window(fold, window)

type Facts172 is Data:
  Facts172{
    abi_version: U32,
    instruction_descriptor: Dcg.Key32,
    now_slot: Dcg.U64,
    roles: Dcg.Roles172,
    policy_facts: Dcg.DpaHeader,
    document: Dcg.Dcm2CloseFacts,
    binding: Dcg.Drb1Binding,
    positions: Dcg.Dpr2Facts,
    family: Dcg.Dfs2Facts,
    template_use: Dcg.Dtu1Facts,
    result: Dcg.Dcr2Summary,
    ledger_fold: Dcg.LedgerFold,
    winner_scan: Dcg.EligibleWinnerFold,
    result_fold: Dcg.ResultFold,
    auxiliary_key: Dcg.Key32
  }

type Plan172 is Data:
  Plan172{
    result_status_after: U32,
    result_status_slot_after: Dcg.U64,
    result_refuted_count_after: U32,
    result_winner_key_after: Dcg.Key32,
    result_bond_state_after: U32,
    result_cause_after: U32,
    result_closed_after: Bool,
    result_retention_start_slot: Dcg.U64,
    result_retention_deadline_slot: Dcg.U64,
    template_documents_after: U32,
    document_accounts_close: Bool,
    policy_facts_close: Bool,
    policy_facts_payout_state_after: Dcg.DpaState,
    policy_facts_refund_role: U32,
    policy_facts_refund_lamports: Dcg.U64,
    document_refund_role: U32,
    document_refund_lamports: Dcg.U64,
    bond_disposition: Dcg.PotDisposition,
    escrow_update: Dcg.EscrowUpdate,
    transfers: Dcg.Transfers8
  }

def identity_facts(facts: Facts172) -> Facts172:
  facts

def identity_plan(plan: Plan172) -> Plan172:
  plan
