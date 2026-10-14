import Base

# Sizing and fold-protocol projections for the designed revision-9 ABI. Rust
# validates authenticated account bytes and builds these values; the module
# does not parse Solana accounts or implement handlers.
type U64 is Data:
  U64{low: U32, high: U32}

type Key32 is Data:
  Key32{w0: U32, w1: U32, w2: U32, w3: U32, w4: U32, w5: U32, w6: U32, w7: U32}

type DpaState is Data:
  Active{}
  CustomEscrowed{}
  CustomPayoutFinal{}
  FallbackPayoutFinal{}

type Winner is Data:
  Unset{}
  Executor{}
  Challenger{}
  Neutral{}

type OutcomeState is Data:
  Unused{}
  Open{}
  Ruled{}
  Settled{}

type PolicyKind is Data:
  Standard{}
  Custom{}

type ResponseKind131 is Data:
  SystemEmpty{}
  ValidatedDru1{}

# The full 144-byte DDT2 v3 numeric policy projection. Committed public keys
# are normalized to fixed account roles only after Rust validates them.
type Terms3 is Data:
  Terms3{
    version: U32,
    challenge_window: U64,
    response_window: U64,
    challenger_bond: U64,
    executor_bond: U64,
    legacy_executor_reward_bps: U32,
    policy_kind: PolicyKind,
    slasher_bps: U32,
    settlement_program_present: Bool,
    fallback_delay_slots: U64,
    result_retention_slots: U64,
    remainder_role: U32,
    abandon_window: U64,
    challenge_limit: U32,
    fallback_anchor_kind: U32
  }

# Semantic projection of the fixed 304-byte DPA1 header. Role references name
# fixed positions in the calling tag's role record; there is no per-role index.
type DpaHeader is Data:
  DpaHeader{
    version: U32,
    state: DpaState,
    capacity: U32,
    row_bytes: U32,
    next_sequence: U64,
    fallback_anchor_slot: U64,
    fallback_deadline_slot: U64,
    earliest_winner_sequence: U64,
    escrowed_pot: U64,
    pot_trigger_slot: U64,
    earliest_winner_key: Key32,
    recorded_payer_role: U32,
    terms: Terms3
  }

# Rust-derived AccountInfo facts. identity_flags losslessly packs alias role
# index in bits0..3, owner class in bits4..5 (System0/DCG1/Other2), signer6,
# writable7, executable8. Bits9..31 must be zero; aliases use lowest role index.
# All fields are derived from validated runtime accounts, never caller input.
type RoleMeta is Data:
  RoleMeta{
    identity_flags: U32,
    lamports_low: U32,
    lamports_high: U32,
    rent_floor_low: U32,
    rent_floor_high: U32,
    data_len: U32
  }

type Roles132 is Data:
  Roles132{challenge: RoleMeta, document: RoleMeta, policy_facts: RoleMeta}

type Roles131 is Data:
  Roles131{
    challenge: RoleMeta,
    response: RoleMeta,
    winner: RoleMeta,
    executor: RoleMeta,
    document: RoleMeta,
    incinerator: RoleMeta,
    challenger: RoleMeta,
    policy_destination: RoleMeta,
    remainder_or_system: RoleMeta,
    policy_facts: RoleMeta
  }

type Roles172 is Data:
  Roles172{
    signer: RoleMeta,
    document: RoleMeta,
    positions: RoleMeta,
    family: RoleMeta,
    result: RoleMeta,
    payer: RoleMeta,
    template_use: RoleMeta,
    auxiliary: RoleMeta,
    tail: RoleMeta,
    incinerator: RoleMeta,
    policy_facts: RoleMeta
  }

type Dcr1Fact is Data:
  Dcr1Fact{
    version: U32,
    sequence: U64,
    phase: U32,
    deadline_slot: U64,
    winner: Winner,
    cause: U32,
    rule_deadline_slot: U64,
    challenge_bond: U64,
    challenger_key: Key32,
    executor_key: Key32
  }

type Dcm2Fact is Data:
  Dcm2Fact{
    version: U32,
    flags: U32,
    next_sequence: U64,
    open_challenges: U32,
    refuted_count: U32,
    finalize_slot: U64,
    dispute_deadline_slot: U64,
    abandon_deadline_slot: U64,
    executor_bond: U64,
    bond_state: U32,
    first_winner_key: Key32
  }

# Full selected DPA1 outcome-row semantics, including its raw challenger key.
type SelectedOutcome is Data:
  SelectedOutcome{
    sequence: U64,
    state: OutcomeState,
    winner: Winner,
    cause: U32,
    challenge_bond: U64,
    open_slot: U64,
    ruling_slot: U64,
    settlement_slot: U64,
    challenger_key: Key32
  }

# Tag 131's full-row scan input has exactly one row. Its sequence is the
# accumulator cursor and its target is fixed by the Bend initializer.
type OutcomeEvidenceCell is Data:
  OutcomeEvidenceCell{
    state: OutcomeState,
    winner: Winner,
    cause: U32,
    challenge_bond: U64,
    open_slot: U64,
    ruling_slot: U64,
    settlement_slot: U64,
    challenger_key: Key32
  }

type WinnerFold is Data:
  WinnerFold{
    target_sequence: U32,
    next_sequence: U32,
    open_rows: U32,
    has_challenger_win: Bool,
    first_challenger_sequence: U32,
    first_challenger_key: Key32,
    valid: Bool
  }

type FoldStep131 is Data:
  FoldStep131{fold: WinnerFold, row: OutcomeEvidenceCell}

type WindowMeta8 is Data:
  WindowMeta8{count: U32}

type SettledWindowCell is Data:
  SettledWindowCell{state: OutcomeState}

type SettledWindow8 is Data:
  SettledWindow8{
    meta: WindowMeta8,
    c0: SettledWindowCell,
    c1: SettledWindowCell,
    c2: SettledWindowCell,
    c3: SettledWindowCell,
    c4: SettledWindowCell,
    c5: SettledWindowCell,
    c6: SettledWindowCell,
    c7: SettledWindowCell
  }

type LedgerFold is Data:
  LedgerFold{total: U32, next_sequence: U32, unsettled_rows: U32, valid: Bool}

type LedgerFoldStep172 is Data:
  LedgerFoldStep172{fold: LedgerFold, window: SettledWindow8}

type CellBytes32 is Data:
  CellBytes32{w0: U32, w1: U32, w2: U32, w3: U32, w4: U32, w5: U32, w6: U32, w7: U32}

type ResultWindowCell is Data:
  ResultWindowCell{value: CellBytes32}

type ResultWindowMeta8 is Data:
  ResultWindowMeta8{count: U32, attested_mask: U32}

type ResultWindow8 is Data:
  ResultWindow8{
    meta: ResultWindowMeta8,
    c0: ResultWindowCell,
    c1: ResultWindowCell,
    c2: ResultWindowCell,
    c3: ResultWindowCell,
    c4: ResultWindowCell,
    c5: ResultWindowCell,
    c6: ResultWindowCell,
    c7: ResultWindowCell
  }

type Drb1Binding is Data:
  Drb1Binding{
    first_output_position: U32,
    output_count: U32,
    output_base_entry: U32,
    output_write: U32,
    output_width: U32,
    decision_flags: U32,
    option_count: U32,
    prompt_positions: U32,
    stop_plus_one: U32,
    option_table_offset: U32
  }

type ResultFoldStart172 is Data:
  ResultFoldStart172{
    binding: Drb1Binding,
    landed_positions: U32,
    output_count: U32,
    output_width: U32,
    result_status: U32
  }

type ResultFold is Data:
  ResultFold{
    total: U32,
    expected_prefix_length: U32,
    next_position: U32,
    attested_prefix_count: U32,
    attested_after_prefix_count: U32,
    stop_before_last_count: U32,
    last_value_is_stop: Bool,
    stop_plus_one: U32,
    output_width: U32,
    decision_mode: Bool,
    scan_skipped_final: Bool,
    bitmap_matches_prefix: Bool,
    valid: Bool
  }

type ResultFoldStep172 is Data:
  ResultFoldStep172{fold: ResultFold, window: ResultWindow8}

type Dpr2Facts is Data:
  Dpr2Facts{capacity: U32, landed_count: U32}

type Dfs2Facts is Data:
  Dfs2Facts{family_count: U32, height: U32, body_length: U32}

type Dtu1Facts is Data:
  Dtu1Facts{state: U32, document_count: U32}

type Dcm2CloseFacts is Data:
  Dcm2CloseFacts{
    next_sequence: U64,
    flags: U32,
    position_capacity: U32,
    landed_positions: U32,
    open_challenges: U32,
    refuted_count: U32,
    finalize_slot_low: U32,
    finalize_slot_high: U32,
    dispute_deadline_slot_low: U32,
    dispute_deadline_slot_high: U32,
    abandon_deadline_slot_low: U32,
    abandon_deadline_slot_high: U32,
    bond_state: U32,
    executor_bond_low: U32,
    executor_bond_high: U32,
    executor_role: U32,
    first_winner_key: Key32
  }

type Dcr2Summary is Data:
  Dcr2Summary{
    record_kind: U32,
    version: U32,
    status: U32,
    closed: Bool,
    finalize_slot_low: U32,
    finalize_slot_high: U32,
    dispute_deadline_slot_low: U32,
    dispute_deadline_slot_high: U32,
    status_slot_low: U32,
    status_slot_high: U32,
    refuted_count: U32,
    output_count: U32,
    first_output_position: U32,
    outputs_attested: U32,
    output_width: U32,
    position_count: U32,
    bond_state: U32,
    cause: U32,
    winner_key: Key32,
    retention_slots_low: U32,
    retention_slots_high: U32,
    retention_start_slot_low: U32,
    retention_start_slot_high: U32,
    retention_deadline_slot_low: U32,
    retention_deadline_slot_high: U32
  }

type Transfer is Data:
  Transfer{source_role: U32, destination_role: U32, lamports: U64}

type Transfers8 is Data:
  Transfers8{
    count: U32,
    t0: Transfer,
    t1: Transfer,
    t2: Transfer,
    t3: Transfer,
    t4: Transfer,
    t5: Transfer,
    t6: Transfer,
    t7: Transfer
  }

# Authoritative ordered-table scan used by ruling and close; its context and
# call-chain provenance must be bound to the enclosing validated fact set.
type EligibleWinnerFold is Data:
  EligibleWinnerFold{
    total: U32,
    next: U32,
    prefix_ruled: Bool,
    has_winner: Bool,
    winner_sequence: U32,
    winner_key: Key32,
    valid: Bool
  }

type RulingScanCell is Data:
  RulingScanCell{state: OutcomeState, winner: Winner, challenger_key: Key32}

type EligibleWinnerStep is Data:
  EligibleWinnerStep{fold: EligibleWinnerFold, row: RulingScanCell}

# Explicit plan operations; no undocumented numeric action code.
type PotDisposition is Data:
  NoPotMovement{}
  StandardDistribution{}
  ExecutorRefund{}
  CreateCustomEscrow{}

type EscrowUpdate is Data:
  PreserveEscrow{}
  SetCustomEscrow{
    amount: U64,
    anchor_slot: U64,
    deadline_slot: U64,
    trigger_slot: U64,
    winner_sequence: U64,
    winner_key: Key32
  }

# The ledger may only name a winner once the row has been ruled.
# Unused rows are structurally consistent with Unset but are still rejected
# by scans over the committed prefix.
def outcome_consistent(state: OutcomeState, winner: Winner) -> Bool:
  match state winner:
    case Unused{} Unset{}:
      True{}
    case Open{} Unset{}:
      True{}
    case Ruled{} Unset{}:
      False{}
    case Settled{} Unset{}:
      False{}
    case Ruled{} _:
      True{}
    case Settled{} _:
      True{}
    case _ _:
      False{}
