use super::token_fixture::TokenFixture;
use super::*;
use solana_program_pack::Pack;
use spl_token::{
    instruction as token,
    state::{Account as TokenAccount, Mint},
};

fn setup() -> TokenFixture {
    let mut f = TokenFixture::new("token-issuance");
    f.send(&[
        token::burn(
            &spl_token::id(),
            &f.user_token.pubkey(),
            &f.mint.pubkey(),
            &f.actor.pubkey(),
            &[],
            1000,
        )
        .unwrap(),
        token::set_authority(
            &spl_token::id(),
            &f.mint.pubkey(),
            Some(&f.custody),
            token::AuthorityType::MintTokens,
            &f.actor.pubkey(),
            &[],
        )
        .unwrap(),
        token::set_authority(
            &spl_token::id(),
            &f.mint.pubkey(),
            None,
            token::AuthorityType::FreezeAccount,
            &f.actor.pubkey(),
            &[],
        )
        .unwrap(),
    ])
    .unwrap();
    f.max_cu = 0;
    f
}

fn ix(f: &TokenFixture, mode: u8, amounts: [u64; 3], initialize: bool) -> Instruction {
    let mut data = vec![mode, 0, 0];
    data.extend_from_slice(f.mint.pubkey().as_ref());
    for amount in amounts {
        data.push(0);
        data.extend_from_slice(&amount.to_le_bytes());
    }
    data.push(u8::from(initialize));
    data.push(0);
    data.extend_from_slice(f.vault_token.pubkey().as_ref());
    data.extend_from_slice(&[0; 34]); // Binding.Any with canonical zero padding.
    Instruction {
        program_id: f.program,
        data,
        accounts: vec![
            AccountMeta::new(f.state.pubkey(), mode == 0),
            AccountMeta::new_readonly(f.actor.pubkey(), true),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(f.custody, false),
            AccountMeta::new(f.user_token.pubkey(), false),
            AccountMeta::new(f.vault_token.pubkey(), false),
            AccountMeta::new(f.mint.pubkey(), false),
        ],
    }
}

fn supply(f: &TokenFixture) -> u64 {
    Mint::unpack(&f.svm.get_account(&f.mint.pubkey()).unwrap().data)
        .unwrap()
        .supply
}

#[test]
fn custody_mint_actor_burn_and_late_failure_are_atomic() {
    let mut f = setup();
    let before = f.snapshot();
    let failed = f
        .send(&[
            f.create(f.state.pubkey(), f.size, f.program),
            ix(&f, 0, [600, 100, 501], true),
        ])
        .unwrap_err();
    assert_eq!(
        failed.err,
        TransactionError::InstructionError(1, InstructionError::Custom(1))
    );
    assert_eq!(
        failed
            .meta
            .logs
            .iter()
            .filter(|line| line.starts_with(&format!("Program {} invoke", spl_token::id())))
            .count(),
        3
    );
    assert_eq!(f.snapshot(), before);
    assert_eq!(supply(&f), 0);

    f.send(&[
        f.create(f.state.pubkey(), f.size, f.program),
        ix(&f, 0, [600, 100, 200], true),
    ])
    .unwrap();
    assert_eq!(f.balances(), (300, 100));
    assert_eq!(supply(&f), 400);
    f.reject(ix(&f, 1, [1, 0, 0], true), Some(24));
    f.reject(ix(&f, 1, [10, 20, 291], false), Some(1));
    f.send(&[ix(&f, 1, [10, 20, 90], false)]).unwrap();
    assert_eq!(f.balances(), (200, 120));
    assert_eq!(supply(&f), 320);
    let state = f.svm.get_account(&f.state.pubkey()).unwrap();
    assert_eq!(
        u32::from_le_bytes(state.data[21..25].try_into().unwrap()),
        2
    );
}

#[test]
fn issuance_validates_mint_authority_freeze_supply_accounts_and_signatures() {
    let mut f = setup();
    f.send(&[
        f.create(f.state.pubkey(), f.size, f.program),
        ix(&f, 0, [100, 0, 0], true),
    ])
    .unwrap();
    let valid = ix(&f, 1, [1, 0, 1], false);
    for (offset, bytes, code) in [
        (0, 0u32.to_le_bytes().to_vec(), 23),
        (4, f.attacker.pubkey().to_bytes().to_vec(), 23),
        (46, 1u32.to_le_bytes().to_vec(), 23),
        (45, vec![0], 14),
    ] {
        let original = f.svm.get_account(&f.mint.pubkey()).unwrap();
        let mut bad = original.clone();
        bad.data[offset..offset + bytes.len()].copy_from_slice(&bytes);
        f.svm.set_account(f.mint.pubkey(), bad).unwrap();
        f.reject(valid.clone(), Some(code));
        f.svm.set_account(f.mint.pubkey(), original).unwrap();
    }
    for index in [4, 5, 6] {
        let mut bad = valid.clone();
        bad.accounts[index].is_writable = false;
        f.reject(bad, Some(5));
    }
    let mut unsigned = valid.clone();
    unsigned.accounts[1].is_signer = false;
    f.reject(unsigned, Some(16));
    let original = f.svm.get_account(&f.user_token.pubkey()).unwrap();
    let mut bad = original.clone();
    bad.data[32..64].copy_from_slice(f.attacker.pubkey().as_ref());
    f.svm.set_account(f.user_token.pubkey(), bad).unwrap();
    f.reject(valid.clone(), Some(17));
    f.svm.set_account(f.user_token.pubkey(), original).unwrap();
    f.send(&[valid]).unwrap();
    assert_eq!(supply(&f), 100);
    assert_eq!(f.balances(), (100, 0));
}

#[test]
fn issued_tokens_are_transferable_and_redeemable_by_their_new_owner() {
    let mut f = setup();
    f.send(&[
        f.create(f.state.pubkey(), f.size, f.program),
        ix(&f, 0, [100, 0, 0], true),
    ])
    .unwrap();
    let receiver = Keypair::new();
    f.send_extra(
        &[
            f.create(receiver.pubkey(), TokenAccount::LEN, spl_token::id()),
            token::initialize_account3(
                &spl_token::id(),
                &receiver.pubkey(),
                &f.mint.pubkey(),
                &f.attacker.pubkey(),
            )
            .unwrap(),
            token::transfer_checked(
                &spl_token::id(),
                &f.user_token.pubkey(),
                &f.mint.pubkey(),
                &receiver.pubkey(),
                &f.actor.pubkey(),
                &[],
                40,
                6,
            )
            .unwrap(),
        ],
        &[&receiver],
    )
    .unwrap();
    let mut redeem = ix(&f, 1, [0, 0, 25], false);
    redeem.accounts[1] = AccountMeta::new_readonly(f.attacker.pubkey(), true);
    redeem.accounts[4] = AccountMeta::new(receiver.pubkey(), false);
    f.send(&[redeem]).unwrap();
    assert_eq!(supply(&f), 75);
    assert_eq!(f.balances(), (60, 0));
    assert_eq!(
        TokenAccount::unpack(&f.svm.get_account(&receiver.pubkey()).unwrap().data)
            .unwrap()
            .amount,
        15
    );
}

#[test]
fn issuance_supports_full_u64_and_rolls_back_supply_overflow() {
    let mut f = setup();
    f.send(&[
        f.create(f.state.pubkey(), f.size, f.program),
        ix(&f, 0, [u64::MAX, 0, 0], true),
    ])
    .unwrap();
    assert_eq!(supply(&f), u64::MAX);
    f.reject(ix(&f, 1, [1, 0, 0], false), None);
    f.send(&[ix(&f, 1, [0, 0, u64::MAX], false)]).unwrap();
    assert_eq!(supply(&f), 0);
    assert_eq!(f.balances(), (0, 0));
}

#[test]
fn bound_transfers_reject_substituted_accounts_and_unsafe_initial_reserves() {
    let mut f = setup();
    for (offset, bytes) in [
        (64, 1u64.to_le_bytes().to_vec()),
        (72, 1u32.to_le_bytes().to_vec()),
        (129, 1u32.to_le_bytes().to_vec()),
        (32, f.actor.pubkey().to_bytes().to_vec()),
    ] {
        let original = f.svm.get_account(&f.vault_token.pubkey()).unwrap();
        let mut bad = original.clone();
        bad.data[offset..offset + bytes.len()].copy_from_slice(&bytes);
        f.svm.set_account(f.vault_token.pubkey(), bad).unwrap();
        let before = f.snapshot();
        let failure = f
            .send(&[
                f.create(f.state.pubkey(), f.size, f.program),
                ix(&f, 0, [100, 20, 0], true),
            ])
            .unwrap_err();
        assert_eq!(
            failure.err,
            TransactionError::InstructionError(1, InstructionError::Custom(26))
        );
        assert_eq!(f.snapshot(), before);
        assert!(!failure
            .meta
            .logs
            .iter()
            .any(|line| line.starts_with(&format!("Program {} invoke", spl_token::id()))));
        f.svm.set_account(f.vault_token.pubkey(), original).unwrap();
    }
    f.send(&[
        f.create(f.state.pubkey(), f.size, f.program),
        ix(&f, 0, [100, 20, 0], true),
    ])
    .unwrap();
    let alternate = Keypair::new();
    f.send_extra(
        &[
            f.create(alternate.pubkey(), TokenAccount::LEN, spl_token::id()),
            token::initialize_account3(
                &spl_token::id(),
                &alternate.pubkey(),
                &f.mint.pubkey(),
                &f.custody,
            )
            .unwrap(),
        ],
        &[&alternate],
    )
    .unwrap();
    let alternate_before = f.svm.get_account(&alternate.pubkey()).unwrap();
    let mut substituted = ix(&f, 1, [1, 1, 0], false);
    substituted.accounts[5] = AccountMeta::new(alternate.pubkey(), false);
    f.reject(substituted, Some(25));
    assert_eq!(
        f.svm.get_account(&alternate.pubkey()).unwrap(),
        alternate_before
    );

    let mut exact = ix(&f, 1, [1, 1, 0], false);
    let offset = exact.data.len() - 34;
    exact.data[offset] = 1; // Binding.Exact{Key{...}}.
    exact.data[offset + 2..].copy_from_slice(f.attacker.pubkey().as_ref());
    f.reject(exact.clone(), Some(25));
    exact.data[offset + 2..].copy_from_slice(f.user_token.pubkey().as_ref());
    f.send(&[exact]).unwrap();
    assert_eq!(f.balances(), (80, 21));
    assert_eq!(supply(&f), 101);
}
