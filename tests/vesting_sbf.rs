use super::token_fixture::TokenFixture;
use super::*;
use solana_program_pack::Pack;
use spl_token::{instruction as token, state::Account as TokenAccount};

fn fixture() -> (TokenFixture, Pubkey) {
    let mut f = TokenFixture::new("vesting");
    let recipient = Keypair::new();
    let ixs = [
        f.create(recipient.pubkey(), TokenAccount::LEN, spl_token::id()),
        token::initialize_account3(
            &spl_token::id(),
            &recipient.pubkey(),
            &f.mint.pubkey(),
            &f.attacker.pubkey(),
        )
        .unwrap(),
    ];
    f.send_extra(&ixs, &[&recipient]).unwrap();
    (f, recipient.pubkey())
}
fn base(
    f: &TokenFixture,
    actor: Pubkey,
    source: Pubkey,
    destination: Pubkey,
    init: bool,
    data: Vec<u8>,
) -> Instruction {
    Instruction {
        program_id: f.program,
        data,
        accounts: vec![
            AccountMeta::new(f.state.pubkey(), init),
            AccountMeta::new_readonly(actor, true),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(f.custody, false),
            AccountMeta::new(source, false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(f.mint.pubkey(), false),
        ],
    }
}
fn init(f: &TokenFixture, total: u64, start: u64, end: u64) -> Instruction {
    let mut data = vec![0, 0, 0];
    data.extend(f.attacker.pubkey().to_bytes());
    data.push(0);
    data.extend(f.mint.pubkey().to_bytes());
    for n in [total, start, end] {
        data.push(0);
        data.extend(n.to_le_bytes());
    }
    assert_eq!(data.len(), 95);
    base(
        f,
        f.actor.pubkey(),
        f.user_token.pubkey(),
        f.vault_token.pubkey(),
        true,
        data,
    )
}
fn claim(f: &TokenFixture, recipient: Pubkey) -> Instruction {
    let mut data = vec![1, 1];
    data.resize(95, 0);
    base(
        f,
        f.attacker.pubkey(),
        f.vault_token.pubkey(),
        recipient,
        false,
        data,
    )
}
fn received(f: &TokenFixture, key: Pubkey) -> u64 {
    TokenAccount::unpack(&f.svm.get_account(&key).unwrap().data)
        .unwrap()
        .amount
}
fn claimed(f: &TokenFixture) -> u64 {
    let data = f.svm.get_account(&f.state.pubkey()).unwrap().data;
    assert_eq!(&data[..20], f.header);
    assert_eq!(data.len(), 124);
    u64::from_le_bytes(data[116..124].try_into().unwrap())
}
fn reject(f: &mut TokenFixture, recipient: Pubkey, ix: Instruction, code: Option<u32>) {
    let before = f.svm.get_account(&recipient);
    f.reject(ix, code);
    assert_eq!(f.svm.get_account(&recipient), before);
}

#[test]
fn vesting_validation_matrix() {
    let (mut f, recipient) = fixture();
    f.send(&[
        f.create(f.state.pubkey(), f.size, f.program),
        init(&f, 1000, 10, 20),
    ])
    .unwrap();
    f.svm.warp_to_slot(15);
    let ix = claim(&f, recipient);
    super::validation::matrix(&mut f, ix, &[(4, 5, 6)], 257, "vesting");
    assert_eq!(received(&f, recipient), 500);
    assert_eq!(claimed(&f), 500);
}

#[test]
fn vesting_funds_claims_partially_and_completes_by_runtime_slot() {
    let (mut f, recipient) = fixture();
    f.send(&[
        f.create(f.state.pubkey(), f.size, f.program),
        init(&f, 1000, 10, 20),
    ])
    .unwrap();
    assert_eq!(f.balances(), (0, 1000));
    for slot in [0, 9, 10] {
        f.svm.warp_to_slot(slot);
        let ix = claim(&f, recipient);
        reject(&mut f, recipient, ix, Some(262));
    }
    for (slot, expected) in [(13, 300), (14, 400), (19, 900), (20, 1000)] {
        f.svm.warp_to_slot(slot);
        f.send(&[claim(&f, recipient)]).unwrap();
        assert_eq!(received(&f, recipient), expected);
        assert_eq!(claimed(&f), expected);
        assert_eq!(f.balances(), (0, 1000 - expected));
        let ix = claim(&f, recipient);
        reject(&mut f, recipient, ix, Some(262));
    }
    f.svm.warp_to_slot(100);
    let ix = claim(&f, recipient);
    reject(&mut f, recipient, ix, Some(262));
    println!("Vesting lifecycle passed; max {} CU", f.max_cu);
    std::fs::write("build/vesting-metrics.json",serde_json::to_vec_pretty(&serde_json::json!({
      "max_cu_including_creation":f.max_cu,"elf_bytes":std::fs::metadata("build/vesting.so").unwrap().len()
    })).unwrap()).unwrap();
}

#[test]
fn vesting_rejects_invalid_schedules_and_failed_funding_atomically() {
    let (mut f, recipient) = fixture();
    for (total, start, end, code) in [
        (0, 10, 20, Some(259)),
        (1000, 10, 10, Some(259)),
        (1000, 20, 10, Some(259)),
        (1001, 10, 20, None),
    ] {
        let before = f.snapshot();
        let error = f
            .send(&[
                f.create(f.state.pubkey(), f.size, f.program),
                init(&f, total, start, end),
            ])
            .unwrap_err();
        if let Some(code) = code {
            assert_eq!(
                error.err,
                TransactionError::InstructionError(1, InstructionError::Custom(code))
            );
        }
        assert_eq!(f.snapshot(), before);
        assert_eq!(received(&f, recipient), 0);
    }
}

#[test]
fn vesting_checks_authority_recipient_encoding_and_frozen_cpi_rollback() {
    let (mut f, recipient) = fixture();
    f.send(&[
        f.create(f.state.pubkey(), f.size, f.program),
        init(&f, 1000, 10, 20),
    ])
    .unwrap();
    f.svm.warp_to_slot(15);
    let mut unsigned = claim(&f, recipient);
    unsigned.accounts[1].is_signer = false;
    reject(&mut f, recipient, unsigned, Some(257));
    let mut wrong_actor = claim(&f, recipient);
    wrong_actor.accounts[1].pubkey = f.actor.pubkey();
    reject(&mut f, recipient, wrong_actor, Some(257));
    let wrong_recipient = claim(&f, f.user_token.pubkey());
    reject(&mut f, recipient, wrong_recipient, Some(17));
    let mut padding = claim(&f, recipient);
    padding.data[94] = 1;
    reject(&mut f, recipient, padding, Some(2));
    let mut alias = claim(&f, recipient);
    alias.accounts[5] = alias.accounts[4].clone();
    reject(&mut f, recipient, alias, Some(6));
    let original = f.svm.get_account(&f.state.pubkey()).unwrap();
    let mut owner = original.clone();
    owner.owner = Pubkey::new_unique();
    f.svm.set_account(f.state.pubkey(), owner).unwrap();
    let ix = claim(&f, recipient);
    reject(&mut f, recipient, ix, Some(3));
    f.svm.set_account(f.state.pubkey(), original).unwrap();
    let freeze = token::freeze_account(
        &spl_token::id(),
        &recipient,
        &f.mint.pubkey(),
        &f.actor.pubkey(),
        &[],
    )
    .unwrap();
    f.send(&[freeze]).unwrap();
    let ix = claim(&f, recipient);
    reject(&mut f, recipient, ix, None);
    let thaw = token::thaw_account(
        &spl_token::id(),
        &recipient,
        &f.mint.pubkey(),
        &f.actor.pubkey(),
        &[],
    )
    .unwrap();
    f.send(&[thaw]).unwrap();
    f.send(&[claim(&f, recipient)]).unwrap();
    f.svm.warp_to_slot(14);
    let ix = claim(&f, recipient);
    reject(&mut f, recipient, ix, Some(261));
    assert_eq!(received(&f, recipient), 500);
}

#[test]
fn vesting_rounds_cumulative_entitlement_and_handles_full_u64() {
    for total in [7, u64::MAX] {
        let (mut f, recipient) = fixture();
        if total > 1000 {
            let mint = token::mint_to(
                &spl_token::id(),
                &f.mint.pubkey(),
                &f.user_token.pubkey(),
                &f.actor.pubkey(),
                &[],
                total - 1000,
            )
            .unwrap();
            f.send(&[mint]).unwrap();
        }
        let start = 1;
        let end = if total == 7 { 4 } else { u64::MAX };
        f.send(&[
            f.create(f.state.pubkey(), f.size, f.program),
            init(&f, total, start, end),
        ])
        .unwrap();
        for slot in [if total == 7 { 2 } else { 1u64 << 63 }, end - 1, end] {
            f.svm.warp_to_slot(slot);
            let expected = if slot >= end {
                total
            } else {
                (total as u128 * (slot - start) as u128 / (end - start) as u128) as u64
            };
            if expected > claimed(&f) {
                f.send(&[claim(&f, recipient)]).unwrap();
            }
            assert_eq!(received(&f, recipient), expected);
            assert_eq!(claimed(&f), expected);
        }
    }
}
