import Base
import ./common.bend as Dcg

type Facts132 is Data:
  Facts132{
    abi_version: U32,
    instruction_descriptor: Dcg.Key32,
    now_slot: Dcg.U64,
    roles: Dcg.Roles132,
    challenge: Dcg.Dcr1Fact,
    document: Dcg.Dcm2Fact,
    policy_facts: Dcg.DpaHeader,
    selected_row: Dcg.SelectedOutcome,
    winner_scan: Dcg.EligibleWinnerFold,
    app_replay_t: U32,
    app_replay_form: U32
  }

type Plan132 is Data:
  Plan132{
    sequence: Dcg.U64,
    winner: Dcg.Winner,
    cause: U32,
    ruling_slot: Dcg.U64,
    challenge_phase_after: U32,
    row_state_after: Dcg.OutcomeState,
    row_winner_after: Dcg.Winner,
    row_cause_after: U32,
    row_ruling_slot_after: Dcg.U64,
    document_refuted_count_after: U32,
    document_flags_after: U32,
    document_winner_key_after: Dcg.Key32,
    dpa1_eligible_winner_sequence_after: Dcg.U64,
    dpa1_eligible_winner_key_after: Dcg.Key32,
    lamport_transfer_count: U32,
    dcr1_aux_t_after: U32,
    dcr1_aux_form_after: U32
  }

def identity_facts(facts: Facts132) -> Facts132:
  facts

def identity_plan(plan: Plan132) -> Plan132:
  plan
