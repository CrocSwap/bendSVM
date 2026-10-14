import Base
import ./common.bend as Dcg
import ./tag131.bend as Settle
import ./tag172.bend as Close
import ./fold-completion.bend as Complete

# Consistency only: these functions derive every completion binding from the
# full fact envelope. They do not authenticate a supplied fold or execute a
# settlement/close. The fold must still come from a private Bend call chain.
def table_binding(header: Dcg.DpaHeader) -> Complete.TableBinding:
  match header:
    case Dcg.DpaHeader{_, _, capacity, _, next, _, _, _, _, _, _, _, terms}:
      match terms:
        case Dcg.Terms3{_, _, _, _, _, _, _, _, _, _, _, _, _, limit, _}:
          Complete.TableBinding{next, capacity, limit}

def same_counter(left: Dcg.U64, right: Dcg.U64) -> Bool:
  match left right:
    case Dcg.U64{a, b} Dcg.U64{c, d}:
      Bool.and(U32.is_eq(a, c), U32.is_eq(b, d))

def prior_bound131(facts: Settle.Facts131) -> Bool:
  match facts:
    case Settle.Facts131{_, _, _, _, _, challenge, document, header, row, _, fold}:
      match challenge document row:
        case Dcg.Dcr1Fact{_, sequence, _, _, _, _, _, _, _, _}
            Dcg.Dcm2Fact{_, _, doc_next, _, _, _, _, _, _, _, _}
            Dcg.SelectedOutcome{selected, _, _, _, _, _, _, _, _}:
          Complete.prior_complete(Complete.PriorCompletion{
            table_binding(header), doc_next, sequence, selected, fold})

def ledger_bound_parts(binding_arg: Complete.TableBinding, doc_arg: Dcg.Dcm2CloseFacts,
    fold: Dcg.LedgerFold) -> Bool:
  match binding_arg doc_arg:
    case Complete.TableBinding{+next, capacity, limit}
        Dcg.Dcm2CloseFacts{doc_next, _, _, _, open_rows, _, _, _, _, _, _, _, _, _, _, _, _}:
      Bool.and(U32.is_zero(open_rows), Bool.and(same_counter(doc_next, next),
        Complete.ledger_complete(Complete.LedgerCompletion{
          Complete.TableBinding{next, capacity, limit}, fold})))

def ledger_bound172(facts: Close.Facts172) -> Bool:
  match facts:
    case Close.Facts172{_, _, _, _, header, document, _, _, _, _, _, fold, _, _, _}:
      ledger_bound_parts(table_binding(header), document, fold)

def winner_bound_parts(binding_arg: Complete.TableBinding, doc_arg: Dcg.Dcm2CloseFacts,
    fold: Dcg.EligibleWinnerFold) -> Bool:
  match binding_arg doc_arg:
    case Complete.TableBinding{+next, capacity, limit}
        Dcg.Dcm2CloseFacts{doc_next, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _}:
      Bool.and(same_counter(doc_next, next),
        Complete.winner_complete(Complete.WinnerCompletion{
          Complete.TableBinding{next, capacity, limit}, fold}))

def winner_bound172(facts: Close.Facts172) -> Bool:
  match facts:
    case Close.Facts172{_, _, _, _, header, document, _, _, _, _, _, _, fold, _, _}:
      winner_bound_parts(table_binding(header), document, fold)

# Every raw key word participates; this is equality, not role classification.
def same_key(left: Dcg.Key32, right: Dcg.Key32) -> Bool:
  match left right:
    case Dcg.Key32{a0, a1, a2, a3, a4, a5, a6, a7}
        Dcg.Key32{b0, b1, b2, b3, b4, b5, b6, b7}:
      Bool.and(Bool.and(U32.is_eq(a0, b0), U32.is_eq(a1, b1)),
        Bool.and(Bool.and(U32.is_eq(a2, b2), U32.is_eq(a3, b3)),
          Bool.and(Bool.and(U32.is_eq(a4, b4), U32.is_eq(a5, b5)),
            Bool.and(U32.is_eq(a6, b6), U32.is_eq(a7, b7)))))

def zero_key() -> Dcg.Key32:
  Dcg.Key32{0, 0, 0, 0, 0, 0, 0, 0}

def winner_cache_values(found: Bool, sequence: U32, +key: Dcg.Key32,
    cached_sequence: Dcg.U64, cached_key: Dcg.Key32, document_key: Dcg.Key32) -> Bool:
  match found cached_sequence:
    case True{} Dcg.U64{low, high}:
      Bool.and(Bool.and(U32.is_eq(sequence, low), U32.is_zero(high)),
        Bool.and(same_key(key, cached_key), same_key(key, document_key)))
    case False{} Dcg.U64{low, high}:
      +zero = zero_key()
      Bool.and(Bool.and(U32.is_eq(low, 4294967295), U32.is_eq(high, 4294967295)),
        Bool.and(U32.is_zero(sequence), Bool.and(same_key(key, zero),
          Bool.and(same_key(cached_key, zero), same_key(document_key, zero)))))

def winner_cache_parts(header: Dcg.DpaHeader, document: Dcg.Dcm2CloseFacts,
    fold: Dcg.EligibleWinnerFold) -> Bool:
  match header document fold:
    case Dcg.DpaHeader{_, _, _, _, _, _, _, sequence, _, _, cache, _, _}
        Dcg.Dcm2CloseFacts{_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, doc_key}
        Dcg.EligibleWinnerFold{_, _, _, found, winner_sequence, key, _}:
      winner_cache_values(found, winner_sequence, key, sequence, cache, doc_key)

# Cache consistency is unconditional. The auxiliary role may be CUSTOM escrow
# or unused; its recipient condition is a separate check below.
# A forged self-consistent fold still needs the private scan provenance check.
def winner_cache_bound172(facts: Close.Facts172) -> Bool:
  match facts:
    case Close.Facts172{_, _, _, _, +header, +document, _, _, _, _, _, _, +fold, _, _}:
      Bool.and(winner_bound_parts(table_binding(header), document, fold),
        winner_cache_parts(header, document, fold))


# HELD=1 is inherited from the existing DCG document contract and remains a
# revision-9 enum-pinning obligation. This is only the winner-recipient clause;
# no-winner burn, remainder and escrow authorization need their own bindings.
def standard_held_winner(policy: Dcg.PolicyKind, held: Bool, found: Bool) -> Bool:
  match policy held found:
    case Dcg.Standard{} True{} True{}:
      True{}
    case _ _ _:
      False{}

def recipient_if(required: Bool, winner: Dcg.Key32, auxiliary: Dcg.Key32) -> Bool:
  match required:
    case True{}:
      same_key(winner, auxiliary)
    case False{}:
      True{}

def recipient_policy(terms: Dcg.Terms3, bond_state: U32, found: Bool,
    key: Dcg.Key32, auxiliary: Dcg.Key32) -> Bool:
  match terms:
    case Dcg.Terms3{_, _, _, _, _, _, policy, _, _, _, _, _, _, _, _}:
      recipient_if(standard_held_winner(policy, U32.is_eq(bond_state, 1), found), key, auxiliary)

def recipient_parts(header: Dcg.DpaHeader, document: Dcg.Dcm2CloseFacts,
    fold: Dcg.EligibleWinnerFold, auxiliary: Dcg.Key32) -> Bool:
  match header document fold:
    case Dcg.DpaHeader{_, _, _, _, _, _, _, _, _, _, _, _, terms}
        Dcg.Dcm2CloseFacts{_, _, _, _, _, _, _, _, _, _, _, _, bond_state, _, _, _, _}
        Dcg.EligibleWinnerFold{_, _, _, found, _, key, _}:
      recipient_policy(terms, bond_state, found, key, auxiliary)

def winner_recipient_bound172(+facts: Close.Facts172) -> Bool:
  match facts:
    case Close.Facts172{_, _, _, _, header, document, _, _, _, _, _, _, fold, _, auxiliary}:
      Bool.and(winner_cache_bound172(facts), recipient_parts(header, document, fold, auxiliary))

# Verdict names mirror the existing resolve_check distinctions. Numeric FINAL=1
# is inherited from the staged initializer and still needs a versioned DCG ABI.
type ResultVerdict is Data:
  ScanRejected{}
  AlreadyFinal{}
  Final{}
  Violated{}

def result_progress_complete(fold: Dcg.ResultFold, attested: U32, skipped: Bool) -> Bool:
  match fold skipped:
    case Dcg.ResultFold{_, _, next, prefix_count, after_count,
        before_count, last_stop, _, _, _, _, _, _} True{}:
      Bool.and(U32.is_zero(next), Bool.and(U32.is_zero(prefix_count),
        Bool.and(U32.is_zero(after_count), Bool.and(U32.is_zero(before_count),
          Bool.not(last_stop)))))
    case Dcg.ResultFold{total, +prefix, next, prefix_count, after_count,
        before_count, _, _, _, _, _, _, _} False{}:
      Bool.and(U32.is_eq(next, total), Bool.and(U32.is_eq(attested, prefix),
        Bool.and(U32.is_eq(prefix_count, prefix), Bool.and(U32.is_zero(after_count),
          Bool.and(U32.is_lt(0, prefix), U32.is_ge(U32.sub(prefix, 1), before_count))))))

def result_complete(+fold: Dcg.ResultFold, expected: Dcg.ResultFold,
    attested: U32) -> Bool:
  match fold expected:
    case Dcg.ResultFold{+total, +prefix, next, prefix_count, after_count,
        before_count, last_stop, +stop, width, mode, +skipped, bitmap, valid}
        Dcg.ResultFold{want_total, want_prefix, _, _, _, _, _, want_stop,
          want_width, want_mode, want_skipped, _, want_valid}:
      +geometry = Bool.and(U32.is_eq(total, want_total),
        Bool.and(U32.is_eq(prefix, want_prefix), Bool.and(U32.is_eq(stop, want_stop),
          Bool.and(U32.is_eq(width, want_width), Bool.and(Close.same_bool(mode, want_mode),
            Close.same_bool(skipped, want_skipped))))))
      +stop_observation_valid = Bool.or(Bool.not(U32.is_zero(stop)),
        Bool.and(U32.is_zero(before_count), Bool.not(last_stop)))
      Bool.and(Bool.and(valid, want_valid), Bool.and(bitmap, Bool.and(geometry,
        Bool.and(stop_observation_valid, result_progress_complete(fold, attested, skipped)))))

def violation_verdict(violated: Bool) -> ResultVerdict:
  match violated:
    case True{}:
      Violated{}
    case False{}:
      Final{}

def stop_verdict(total: U32, prefix: U32, before_count: U32,
    last_stop: Bool, stop_enabled: Bool) -> ResultVerdict:
  match stop_enabled:
    case False{}:
      Final{}
    case True{}:
      violation_verdict(Bool.or(Bool.not(U32.is_zero(before_count)),
        Bool.and(U32.is_lt(prefix, total), Bool.not(last_stop))))

def result_after_admission(total: U32, prefix: U32, before_count: U32,
    last_stop: Bool, stop: U32, mode: Bool, skipped: Bool) -> ResultVerdict:
  match skipped:
    case True{}:
      AlreadyFinal{}
    case False{}:
      stop_verdict(total, prefix, before_count, last_stop,
        Bool.and(Bool.not(mode), Bool.not(U32.is_zero(stop))))

def result_verdict_checked(fold: Dcg.ResultFold, admitted: Bool) -> ResultVerdict:
  match fold admitted:
    case Dcg.ResultFold{total, prefix, _, _, _, before_count, last_stop,
        stop, _, mode, skipped, _, _} True{}:
      result_after_admission(total, prefix, before_count, last_stop, stop, mode, skipped)
    case Dcg.ResultFold{_, _, _, _, _, _, _, _, _, _, _, _, _} False{}:
      ScanRejected{}

# Row 1 only: finalized, not refuted, with attested==span. Row selection must
# precede this call. Other close rows must not interpret this verdict as refusal.
# Rebuild initialization facts from the same full envelope, then bind the final
# fold before deciding. This does not certify that the supplied fold was scanned.
def result_row1_bound172(facts: Close.Facts172) -> ResultVerdict:
  match facts:
    case Close.Facts172{_, _, _, _, _, document, binding, _, _, _, result, _, _, +fold, _}:
      match document result:
        case Dcg.Dcm2CloseFacts{_, _, _, landed, _, _, _, _, _, _, _, _, _, _, _, _, _}
            Dcg.Dcr2Summary{_, _, status, _, _, _, _, _, _, _, _, count, _, attested, width, _, _, _, _, _, _, _, _, _, _}:
          +expected = Close.start_result_fold172(Dcg.ResultFoldStart172{
            binding, landed, count, width, status})
          result_verdict_checked(fold, result_complete(fold, expected, attested))
