# DCG revision 9 facts and plans — integrated schema proposal

> The integrated revision includes required keys and transfer sources. Generic
> large-decoder outlining resolves the former tag-172 frame overflow (4,416
> bytes). Fresh full sizing compilation measures frames of 1,728 / 2,240 /
> 2,304 bytes for tags 132 / 131 / 172. Facts use 675 / 879 / 954 wire bytes;
> plans use 138 / 335 / 340. The older table below is historical evidence.
> No required facts were removed. The focused main fact, binding and receipt
> gates passed. These are not handler execution measurements or validation of
> subsequent compiler edits; the final combined regression remains due.

## Integration status — 2026-10-01

The reviewed schema, fold and binding corrections described below are now in
the main working tree. The focused fact gate measured all three SBF wrappers;
the native binding gate and receipt failure probes also passed. Evidence is
recorded in `build/overnight/dcg-main-gate-evidence.json` and
`build/overnight/dcg-receipt-sha-fresh-evidence.json`. Those receipts bind their
recorded inputs, not every later compiler revision.

| Tag | Fact wire/native bytes | Plan wire/native bytes | Identity wrapper frame |
|---|---:|---:|---:|
| 132 | 675 / 860 | 138 / 180 | 1,728 |
| 131 | 879 / 1,092 | 335 / 452 | 2,240 |
| 172 | 954 / 1,136 | 340 / 456 | 2,304 |

Tag 172 has 70 bytes of canonical-value headroom under the 1,024-byte bound;
the dispatcher adds its separate selector byte. Its identity wrapper has
1,792 bytes of frame headroom under 4,096. The six-function binding wrapper
instead peaks at 3,072 bytes. Neither frame figure predicts a complete handler.

The detailed development record below retains earlier measurements and staged
status language as history; this section supersedes its integration status.
Protocol decisions, authenticated extraction, accumulator provenance, executor
behavior and full lifecycle/CU tests remain outside this schema milestone.

The tests require the exact DCG commit in `tests/dcg-facts/dcg-inputs.json`.
The upstream checkout has since changed account layouts and the pilot contract;
these results do not establish compatibility with its newer HEAD. Use
`DCG_ROOT` to select a clean checkout of the pinned commit for a replay, and
review upstream changes before updating that pin. Account-address readiness has
not been confirmed, so handler implementation remains gated.


This is a schema and fold proposal, not a DCG handler or an authenticated fact
extractor. The source reference is DCG commit
`40fc9ad6fb1e14b63f65e72b12da6dca5cc0d4b1`, especially
`docs/spec/dispute-economics-v2.md` §§2–5 and the settlement pilot contract.
Revision 9 remains a design proposal; revision 8 and deployed images stay
unchanged. Handler work is still gated on the account-address rule.

The correction adds the ruling-time ordered winner scan and missing plan
writes. It preserves raw cached winner keys: tag 132 has only DCR1, DCM2 and
DPA1 roles, so an arbitrary challenger key cannot be represented by one of its
account-role numbers. The schemas deliberately retain both authoritative row
facts and cached keys; equality must be checked before a cache is used.

## Historical envelopes and measured limits

| Tag | Instruction | Accounts | Fact wire/native bytes | Plan wire/native bytes | Identity wrapper frame |
|---|---|---:|---:|---:|---:|
| 132 | `0x84 || descriptor[32]` | 3 | 667 / 852 | 130 / 172 | 2,944 |
| 131 | `0x83 || descriptor[32]` | 10 | 879 / 1,092 | 303 / 420 | 3,968 |
| 172 | `0xac || descriptor[32]` | 11 | 902 / 1,108 | 308 / 424 | 3,968 |

Canonical requests add one dispatcher byte. These host probe measurements use
the current compiler and pinned Anza toolchain, identity facts/plan exports,
and a static 1,024-byte output buffer. They exclude Rust and actual decision
logic. Both larger envelopes have only 128 bytes of frame margin; this is not
acceptance of a real handler or a worst-case CU bound. An earlier draft
exceeded the frame limit at tag 131 (4,160 bytes); flattening role balance/rent
limbs reduced it to 3,968 without losing values.

The regular codec, fold and receipt gate still needs to be updated and rerun
against these corrected schemas. The probe is not a substitute for it.

## Account metadata and keys

Fixed account order follows the pilot plus DPA1: index 2 for 132, 9 for 131,
and 10 for 172. Each `RoleMeta` carries:

- `identity_flags`: bits 0–3 are the lowest fixed role index with the same
  actual key; bits 4–5 are owner class (0 System, 1 DCG, 2 other; 3 invalid);
  bit 6 signer, bit 7 writable, bit 8 executable. Bits 9–31 must be zero.
- `lamports_low/high` and `rent_floor_low/high`: exact low/high U32 limbs of
  the corresponding runtime U64. Flattening removes nested constructor tags;
  it does not truncate the amounts.
- `data_len`: full U32 account length, checked against the account size limit.

Alias groups and normalized role references always choose the lowest matching
fixed role index. The `0xffffffff` role sentinel means no matching role and is
legal only where the field contract explicitly allows absence. A transfer or
close destination may never use that sentinel. Raw keys in DPA1/DCM2 caches,
selected rows, winner folds and plan writes remain full `Key32` values.

Rust derives all metadata from validated accounts. It checks independent
address provenance, owner, kind/version, reserved bytes, parent relationships,
exact or bounded allocation, PDA bindings and required privileges. A canonical
Bend codec does not authenticate those facts. The above bit packing is a
proposed internal ABI assignment, not an existing DCG external byte format.

## Inputs retained

`Dcr1Fact` retains sequence, phase/deadlines, winner/cause, challenge bond and
challenger/executor keys. `SelectedOutcome` retains the complete chosen DPA1
row, including open/ruling/settlement slots. `Dcm2Fact` retains flags, counters,
deadlines, held bond and its state, and the raw cached winner. `DpaHeader`
retains state, capacity/stride/counter, cached sequence/key, escrow amount,
trigger/anchor/deadline, payer role and the complete numeric `Terms3` policy
projection. Public policy keys normalized to roles must first be matched
against their authenticated full keys.

Tag 172 additionally retains DCM2 capacity/landed/finality facts, the DRB1
binding projection, DPR2 and DFS2 shape facts, DTU1 state/count, and DCR2
status/closed/deadlines/counts/bond/cause/winner/retention facts. Its ledger,
winner and result folds are separate bounded inputs. Account contents not used
as decision inputs remain in the validated accounts; their hashes or validated
bindings must not be confused with a proof of a decision made in Rust.

## Required fold binding and provenance

The accumulators are ordinary values and can be forged by a caller. A type or
successful re-encoding does not prove that a fold ran. The future internal
Rust/Bend bridge must initialize in Bend, feed every required authenticated row
in order, and retain each Bend-returned accumulator in private call-local
storage. It must not accept an accumulator from instruction data or select
different starting facts. This call-chain obligation needs native and SBF
adversarial tests; it is not implemented by these schemas.

The final Bend decision must independently bind:

- 131: `fold.target_sequence == DCR1.sequence == selected_row.sequence`, with
  both U64 high limbs zero, cursor equal to target, validity true, and no OPEN
  lower rows. DPA1/DCM2 next counters agree, bound the selected index, and are
  no greater than the committed capacity/1,024 limit.
- 132 and 172 winner scans: total equals the authenticated DPA1 next counter
  (high limb zero), cursor equals total, validity true. Scan results must agree
  with any cache used. For 132, the scan observes the proposed paired ruling
  of the selected row, derived by Bend; Rust must not invent that overlay.
- 172 ledger: total equals that same counter, cursor equals total, validity
  true, and every row is SETTLED. An empty caller-selected prefix is invalid
  when the authenticated table is nonempty.
- 172 result (row 1 only): total, expected prefix length, stop-plus-one, width, decision
  mode, and the FINAL-skip flag are rederived from the validated DRB1, DCM2 and
  result facts. The skipped flag is equivalent to the accepted FINAL status,
  never a caller choice. Every scanned cell/bitmap position is accounted for.

`eligible-winner.bend` computes the first challenger-win row whose entire
earlier prefix is ruled/settled. An OPEN earlier row blocks eligibility; an OPEN
later row does not invalidate an already eligible winner. UNUSED rows in the
allocated prefix and out-of-range steps invalidate the fold. This generic scan
has checked-source/native examples; no ruling overlay or final decision is
yet connected to it. The other existing folds likewise require the binding
checks above before handler use.

All scans need CU measurements. No claim is made that 1,024 row calls fit in a
transaction. The result scan should read bitmap words and only relevant output
cells rather than every cell; bitmap padding bits need an explicit checked
owner. Large non-FINAL scans may require a committed progress record or a cap.

## Complete plan data being added

132 carries paired DCR1/DPA1 ruling values, DCM2 flags/refuted count/winner,
and DPA1 eligible winner sequence/key. It moves no lamports.

131 carries challenge/response closes, selected-row settlement state/slot,
DPA1/DCM2 winner keys, open count/bond state, payout state and an explicit
`EscrowUpdate`. 172 carries result status/status slot/refuted count/winner/
bond state/cause, close/retention values, DTU1 decrement, working-account and
DPA1 close/refund data, payout state and the same escrow update.

`PotDisposition` has named variants: no movement, standard distribution,
executor refund, or custom escrow creation. `SetCustomEscrow` carries the
amount, anchor, checked deadline, trigger slot and winner sequence/key; its
state marker is CUSTOM_ESCROWED. `PreserveEscrow` leaves those bytes unchanged,
so retries cannot restart the timer. No winner is U64 max/zero key. Anchor kind
1 uses the winning ruling slot or no-winner terminal disposition slot; kind 2
uses the committed dispute deadline. These are plan semantics still to be
implemented and tested, not choices for the Rust executor.

Plans are subject to whole-plan validation before mutation, exact role/range
allowlists, alias-aware checked balance overlays, bounded repeated transfers,
close ordering, and no access after close. Payout finality does not close DPA1:
172 closes it only after all rows settle, zero open challenges is authenticated,
and payout is terminal or none is due. Refund goes to its recorded payer.

## External layouts and remaining contract gaps

DDT2 v3 is 144 bytes. DPA1 header/rows are 304/80 bytes. DCR1 v7 sequence is at
184..192. DCM2 v8 moves DDT2 to 1842..1986, DRB1 to 1986..2182, abandon deadline
to 2182..2190, next sequence to 2190..2198, and options to 2198 onward. DCR2 v7
has a 424-byte header, DDT2 at 216..360, winner at 360..392, retention fields at
392..416, bond state/cause/bump at 416/417/418, and zero bytes 419..424.

These unresolved items block a claim of a complete handler contract:

- Economics §2 requires a paired DCR1 ruling-slot write, but its v7 layout
  table names no ruling-slot field. Do not invent an offset or call a DPA1-only
  write conformance; DCG must reconcile that inconsistency.
- DCRZ v3 and tag-172 cleanup after DCM2/working accounts close need a precise
  fact variant and byte contract. The ordinary close envelope must not be
  populated with invented zero DCM2 facts on cleanup. The current DCG
  `crates/dcg-program/src/unified/result.rs` establishes v2's 200-byte size,
  cause at 96, reserved bytes 97..104 and program/remainder/winner keys at
  104/136/168. `unified/bond.rs::read_settlement_with_hooks` accepts v2 only
  with byte 7 equal to 1 (live escrow). That v2 acceptance predicate must not
  be reused for v3 cleanup after payout, when the live-escrow marker may have
  been cleared. Economics §3.3 specifies the cleanup lifecycle and §5 retains
  the v2 fields, but the v3 post-payout shape and accepted marker combinations
  still need an explicit contract. Existing v2 code is evidence of v2 only.
- Phase, cause, bond-state and result-status numeric maps must be versioned
  against the final revision-9 wire contract. The owner/privilege packing above
  does not resolve those external enums.
- The independent address rule, ruling overlay, final fold binding functions,
  compact bitmap scan, full native/codec negatives and actual Rust/Bend/SBF
  call-chain/CU measurements remain outstanding.

No settlement decision, account extractor, generic executor, deployed program,
or end-to-end compiler theorem is established by this draft.

### Fold accumulator bounds (staged validation)

The generic 131 and 172 step functions independently check ledger capacity,
cursor range and accumulator counts even when an input claims `valid = True`.
Window checks use `next <= total` and `count <= total - next`; a wrapping
`next + count` cannot authorize a step. Counter increments are bounded by the
accepted cursor progression. These checks reject nine forged cases that the
previous draft accepted; three ordinary cases pass in emitted native C under
ASan/UBSan. This is finite regression evidence, not a preservation theorem or
proof that a caller supplied an authentic accumulator. Final fact bindings and
the private initialization-to-finalization call chain are still required.

### Staged final consistency checks

`fold-completion.bend` supplies `ledger_complete`, `winner_complete` and
`prior_complete`. They bind cursor/total to the table counter, reject nonzero
U64 high limbs, enforce capacity equals the committed limit in 1..1,024, and
reject incomplete prefixes. The prior-challenge check additionally requires
DCM2/DPA1 counters to agree, DCR1/selected-row/fold sequences to agree, no OPEN
prior rows and any found winner to precede the selected challenge. The ledger
check requires no unsettled rows. The winner check bounds a found winner's
index but does not require later challenges to be ruled.

These are standalone consistency functions with finite emitted-native
ASan/UBSan regression evidence. They are not wired into a handler or an
extractor. Their binding arguments must be constructed inside the future
Bend core from the validated fact envelope, not supplied independently by the
caller. An internally consistent forged accumulator can still pass; the
private call-chain provenance obligation and 132 ruling overlay remain open.

### Full-envelope completion bindings (staged)

`fact-bindings.bend` derives the table capacity, committed challenge limit,
DPA1 next sequence, document next sequence and selected/challenge sequence
directly from `Facts131` or `Facts172`, then applies the completion predicates.
The ordinary tag-172 ledger check additionally requires the document's open
challenge count to be zero. These checks accept the full fact envelope; callers
cannot separately choose the completion binding fields. They still do not
authenticate the envelope or a forged-but-consistent accumulator. Private Bend
initialization/stepping, account extraction and the cleanup variant remain due.

Forty-three emitted native C cases passed with ASan/UBSan, covering cross-record
counter mismatches, high limbs, commitment/capacity mismatches, incomplete scans,
open/unsettled rows and out-of-prefix winners. A compiled SBF stack probe of the
three consistency exports peaks at 3,008 bytes. Input facts remain 879/902 bytes
(excluding the one-byte export selector), largest native value 1,108 bytes.
This is a raw test entrypoint stack measurement, not handler execution or CU
evidence. The source passed Bend checking; no new adjacent-law theorem is
claimed. Earlier syntax attempts rejected computed match scrutinees and a
binder spelling; corrected parameter/field matches passed.

### Result bitmap window bounds (staged)

The result step rejects set bits outside its declared 1–8 active positions,
including bits above the low byte. Exhaustive masks 0–256 for each width, plus
invalid counts and full-U32 masks, pass 2,061 emitted native cases under
ASan/UBSan. The previous source accepts 1,548 of these invalid-mask cases;
that comparison is retained separately. This validates the supplied window,
not account extraction. The future bridge must preserve the original final
bitmap byte (including padding) rather than pre-mask it. It must also bind
window offsets and complete coverage to the authenticated result layout.

A staged checked-source SMT refinement additionally proves the mask bound for
all U32 masks at counts 1–8, and that a successful actual result-step call
requires the bound. Three corrupted helper definitions and a call-site bypass
produce solver counterexamples. The proof exports checked Bend terms and uses
the existing source evaluator and Z3 5.1.0; those components, Base primitive
semantics and the driver remain trusted. It is not a C/SBF preservation proof.
The probe runs Python isolated from optimization environment variables and
loads the evaluator from its source bytes. The provisional proof driver and
model artifacts remain in the staged validation area pending integration and
independent review.

### Review corrections: row consistency and byte alignment (staged)

The eligible-winner and tag-131 scans reject Open rows with a named winner and
Ruled/Settled rows with Unset. Committed-prefix scans continue to reject Unused.
Result windows start at a multiple of eight and contain eight cells unless
ending exactly at the total length; the raw final byte must still satisfy the
mask bound. Bounds use subtraction after a separate range check to exclude
cursor wraparound.

A native ASan/UBSan probe covers 496 row/window cases, including a real 8+1
window chain and rejection of the former 1+8 chain. The connected mask SMT
check and its four semantic mutants pass after this correction. Identity
fact/plan sizing and frames remain unchanged. These guards do not establish
accumulator provenance, authenticated extraction, or a complete handler.

### Required field corrections after independent review (not integrated)

- Facts132 adds `app_replay_t` and `app_replay_form`, derived from validated
  DEV2 bytes at `DEV2_AT+20..24` and `DEV2_AT+24..26` for app-replay v6.
  Other versions supply zero inactive values. Plan132 adds
  `dcr1_aux_t_after` and `dcr1_aux_form_after`: the executor writes t little
  endian at DCR1 170..174, form at 174..176 (rejecting form >65535), and zero
  at 176..178. Non-app-replay plans require both fields zero. These are the
  existing version-dependent auxiliary bytes, not a fabricated ruling-slot
  offset; the revision-9 paired DCR1 ruling-slot layout remains unresolved.
- Facts172 now retains the auxiliary account's full key. Dcr2Summary retains
  the full recorded winner key, replacing the lossy role index. Future Bend
  final binding must compare scan/cached keys and conditionally the recipient key. An executor
  must check that a destination role's actual key equals the plan's winner key.
- Every Transfer explicitly names `source_role`, `destination_role` and amount.
  Neither source nor recipient may be inferred solely from transfer order.
- Dcr2Summary's six U64 timestamps and Dcm2CloseFacts' four non-sequence U64
  amounts/timestamps use explicit low/high U32 limbs. This is lossless internal
  schema layout; it does not change the DCG account wire layout. The attempted
  optimization worsened compiled frame size and is not accepted as a fix.

Rust extraction must additionally check each scan row's sequence equals its
cursor, DPA1's DDT2 copy equals DCM2's byte for byte, and row_bytes equals80.
Only close row1 (finalized, not refuted) requires DCR2 outputs_attested to equal
the validated output-span length L. Row selection precedes that condition:
WITHHELD/refuted and unfinalized-abandon paths must not inherit it.
The raw auxiliary_key for tag172 and policy_destination_key for tag131 must
come from the actual role7 account key. Ledger and winner scans must traverse
the same validated rows; matching counters alone does not establish that.
These are obligations, not implemented/exercised bridge guarantees. The
separate source fold guards and consistency checks do not discharge them.

### Full-fact cache and result bindings (staged)

`winner_cache_bound172` checks the completed scan/table bounds and compares all
eight winner-key words with both DPA1 and DCM2 caches. The cached U64 sequence
must match the scanned sequence. With no winner, the cache requires U64-max/zero
and the fold retains its initial zero key/sequence. This unconditional cache
check does not constrain the auxiliary account to be the winner.

`winner_recipient_bound172` adds winner/auxiliary key equality only for a
STANDARD policy with a HELD bond and an eligible winner. CUSTOM uses an escrow
auxiliary, and a non-HELD bond does not use it for this winner transfer. This
recipient condition follows revision-9 spec §2, not revision-8 Rust's
close-cause rule. With all rows SETTLED, STANDARD + HELD + winner found should
be unreachable: tag131 should already have paid the pot. This is a defensive
guard, not evidence of a reachable payout branch. The
helper is only the winner-recipient clause; it does not authorize no-winner
burn/remainder destinations or escrow operations. HELD numeric value1 follows
the existing Rust contract and still needs revision-9 enum pinning. An 87-case
native ASan/UBSan probe covers caches, all recipient words, CUSTOM and non-HELD
exceptions, and sentinel/counter drift.

`result_row1_bound172` applies only after selecting close row1: finalized,
not refuted, with outputs_attested equal to output-span length. It is not a
global close predicate; other close rows do not call resolve_check and must
not interpret this helper's rejection as a global refusal. It rebuilds
initialization from result, binding and landed-position facts, checks the
final fold's immutable geometry, exact bitmap prefix/counts, and stored
attested count, then returns ScanRejected, AlreadyFinal, Final or Violated.
Stop-rule violations remain verdicts, not malformed-scan refusals. The
already-FINAL path requires an unchanged skip accumulator and reads no scan
windows. Its FINAL numeric value1 follows the existing initializer/Rust
contract and still needs the revision-9 enum contract. A 39-case native
ASan/UBSan probe includes a pristine zero-count skipped accumulator with
non-FINAL status, in addition to geometry, verdict and stop-rule cases.

The revised six-function wrapper compiles with a 3,072-byte maximum frame.
Largest native argument is 1,136 bytes and tag-172 wire argument is 954 bytes. This is distinct
from the full identity round-trip sizing wrapper above. Native tests and stack
compilation do not establish scan provenance, authentication, SBF execution,
or complete handlers. Revised bindings still need independent review and
lifecycle integration.

A source mutation deleting the skipped/status equality guard typechecked and
emitted successfully, then failed the new pristine-skip test. Restoring the
guard restored all 39 passing cases. This is finite mutation sensitivity,
not a preservation proof.
