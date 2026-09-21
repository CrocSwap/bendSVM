use super::token_fixture::TokenFixture;
use super::*;

fn instruction(
    f: &TokenFixture,
    initialize: bool,
    amounts: [u64; 3],
    last_mint: u32,
) -> Instruction {
    let mut data = vec![if initialize { 0 } else { 1 }, 0, 0];
    data.extend_from_slice(f.mint.pubkey().as_ref());
    for amount in amounts {
        data.push(0);
        data.extend_from_slice(&amount.to_le_bytes());
    }
    data.extend_from_slice(&last_mint.to_le_bytes());
    Instruction {
        program_id: f.program,
        accounts: vec![
            AccountMeta::new(f.state.pubkey(), initialize),
            AccountMeta::new_readonly(f.actor.pubkey(), true),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(f.custody, false),
            AccountMeta::new(f.user_token.pubkey(), false),
            AccountMeta::new(f.vault_token.pubkey(), false),
            AccountMeta::new_readonly(f.mint.pubkey(), false),
        ],
        data,
    }
}

fn count(f: &TokenFixture) -> u32 {
    let state = f.svm.get_account(&f.state.pubkey()).unwrap();
    assert_eq!(&state.data[..20], &f.header);
    assert_eq!(state.data[20], 0);
    u32::from_le_bytes(state.data[21..25].try_into().unwrap())
}

#[test]
fn three_token_effects_commit_and_roll_back_atomically() {
    let mut f = TokenFixture::new("token-three");
    let before = f.snapshot();
    let failed = f
        .send(&[
            f.create(f.state.pubkey(), f.size, f.program),
            instruction(&f, true, [10, 20, 31], 6),
        ])
        .unwrap_err();
    assert_eq!(
        failed.err,
        TransactionError::InstructionError(1, InstructionError::Custom(1))
    );
    assert_eq!(
        f.snapshot(),
        before,
        "failed initialization must undo allocation and both deposits"
    );

    f.send(&[
        f.create(f.state.pubkey(), f.size, f.program),
        instruction(&f, true, [10, 20, 5], 6),
    ])
    .unwrap();
    assert_eq!(f.balances(), (975, 25));
    assert_eq!(count(&f), 1);

    // A malformed third leg must be caught before the first, which would fail
    // with insufficient funds if it were invoked. Exact error establishes order.
    f.reject(instruction(&f, false, [10_000, 20, 1], 99), Some(12));

    let before = f.snapshot();
    let failed = f
        .send(&[instruction(&f, false, [1, 2, 29], 6)])
        .unwrap_err();
    assert_eq!(
        failed.err,
        TransactionError::InstructionError(0, InstructionError::Custom(1))
    );
    let token_invocations = failed
        .meta
        .logs
        .iter()
        .filter(|line| line.starts_with(&format!("Program {} invoke", spl_token::id())))
        .count();
    assert_eq!(
        token_invocations, 3,
        "third CPI fails after two real successful CPIs"
    );
    assert_eq!(f.snapshot(), before);

    f.send(&[instruction(&f, false, [1, 2, 28], 6)]).unwrap();
    assert_eq!(f.balances(), (1000, 0));
    assert_eq!(count(&f), 2);
    std::fs::write(
        "build/token-three-validation.json",
        serde_json::to_vec_pretty(&serde_json::json!({
            "effects":3, "prevalidation_before_first_cpi":true,
            "late_cpi_failure_rolls_back_state_and_tokens":true,
            "failed_initialization_rolls_back_allocation":true,
            "recovery_after_failure":true, "max_cu_including_creation":f.max_cu
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn three_token_effects_commit_multiple_states_atomically() {
    let mut f = TokenFixture::new("token-three-multi");
    let secondary = Keypair::new();
    let ix = |f: &TokenFixture, initialize, amounts, last_mint| {
        let mut ix = instruction(f, initialize, amounts, last_mint);
        ix.accounts
            .insert(4, AccountMeta::new(secondary.pubkey(), initialize));
        ix
    };
    let before = f.snapshot();
    f.send_extra(
        &[
            f.create(f.state.pubkey(), f.size, f.program),
            f.create(secondary.pubkey(), f.size, f.program),
            ix(&f, true, [10, 20, 31], 7),
        ],
        &[&secondary],
    )
    .unwrap_err();
    assert_eq!(f.snapshot(), before);
    assert!(f.svm.get_account(&secondary.pubkey()).is_none());

    f.send_extra(
        &[
            f.create(f.state.pubkey(), f.size, f.program),
            f.create(secondary.pubkey(), f.size, f.program),
            ix(&f, true, [10, 20, 5], 7),
        ],
        &[&secondary],
    )
    .unwrap();
    assert_eq!(count(&f), 1);
    assert_eq!(f.balances(), (975, 25));
    let secondary_before = f.svm.get_account(&secondary.pubkey()).unwrap();
    assert_eq!(
        u32::from_le_bytes(secondary_before.data[21..25].try_into().unwrap()),
        2
    );
    f.reject(ix(&f, false, [1, 2, 29], 7), Some(1));
    assert_eq!(
        f.svm.get_account(&secondary.pubkey()).unwrap(),
        secondary_before
    );
    f.reject(ix(&f, false, [10_000, 2, 1], 99), Some(12));
    assert_eq!(
        f.svm.get_account(&secondary.pubkey()).unwrap(),
        secondary_before
    );
    f.send(&[ix(&f, false, [1, 2, 28], 7)]).unwrap();
    assert_eq!(count(&f), 2);
    let secondary_after = f.svm.get_account(&secondary.pubkey()).unwrap();
    assert_eq!(
        u32::from_le_bytes(secondary_after.data[21..25].try_into().unwrap()),
        4
    );
    assert_eq!(f.balances(), (1000, 0));
}
