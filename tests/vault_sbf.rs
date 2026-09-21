use super::token_fixture::TokenFixture as Vault;
use super::*;
use spl_token::instruction as token;

impl Vault {
    fn ix(&self, op: u8, amount: u64) -> Instruction {
        // Canonical Instruction is tag + maximum constructor payload (33 bytes).
        let mut data = vec![if op == 0 { 0 } else { 1 }, op, 0];
        if op == 0 {
            data.extend(self.mint.pubkey().to_bytes());
        } else {
            data.extend(amount.to_le_bytes());
            data.resize(35, 0);
        }
        let mut accounts = vec![
            AccountMeta::new(self.state.pubkey(), op == 0),
            AccountMeta::new_readonly(self.actor.pubkey(), true),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(self.custody, false),
        ];
        if op == 0 {
            accounts.push(AccountMeta::new_readonly(self.mint.pubkey(), false));
        } else {
            let (source, destination) = if op == 1 {
                (self.user_token.pubkey(), self.vault_token.pubkey())
            } else {
                (self.vault_token.pubkey(), self.user_token.pubkey())
            };
            accounts.extend([
                AccountMeta::new(source, false),
                AccountMeta::new(destination, false),
                AccountMeta::new_readonly(self.mint.pubkey(), false),
            ]);
        }
        Instruction {
            program_id: self.program,
            accounts,
            data,
        }
    }
    fn initialize(&mut self) {
        self.send(&[
            self.create(self.state.pubkey(), self.size, self.program),
            self.ix(0, 0),
        ])
        .unwrap();
    }
    fn ledger(&self) -> u64 {
        let data = self.svm.get_account(&self.state.pubkey()).unwrap().data;
        assert_eq!(&data[..20], self.header);
        assert_eq!(data[20], 1);
        assert_eq!(data[21], 0);
        assert_eq!(&data[22..54], self.actor.pubkey().as_ref());
        assert_eq!(data[54], 0);
        assert_eq!(&data[55..87], self.mint.pubkey().as_ref());
        assert_eq!(data[87], 0);
        u64::from_le_bytes(data[88..96].try_into().unwrap())
    }
}

#[test]
fn vault_validation_matrix() {
    let mut f = Vault::new("vault");
    f.initialize();
    f.send(&[f.ix(1, 500)]).unwrap();
    let ix = f.ix(2, 1);
    super::validation::matrix(&mut f, ix, &[(4, 5, 6)], 257, "vault");
    assert_eq!(f.ledger(), 499);
    assert_eq!(f.balances(), (501, 499));
}

#[test]
fn vault_custodies_real_tokens_and_withdraws_with_pda_signature() {
    let mut f = Vault::new("vault");
    f.initialize();
    assert_eq!(f.ledger(), 0);
    assert_eq!(f.balances(), (1000, 0));
    f.send(&[f.ix(1, 600)]).unwrap();
    assert_eq!(f.ledger(), 600);
    assert_eq!(f.balances(), (400, 600));
    f.send(&[f.ix(2, 250)]).unwrap();
    assert_eq!(f.ledger(), 350);
    assert_eq!(f.balances(), (650, 350));
    f.send(&[f.ix(2, 350)]).unwrap();
    assert_eq!(f.ledger(), 0);
    assert_eq!(f.balances(), (1000, 0));
    f.reject(f.ix(2, 1), Some(261));
    f.send(&[f.ix(1, 0)]).unwrap();
    f.send(&[f.ix(2, 0)]).unwrap();
    println!("Vault token lifecycle passed; max {} CU", f.max_cu);
    std::fs::write("build/vault-metrics.json",serde_json::to_vec_pretty(&serde_json::json!({
        "max_cu_including_creation":f.max_cu,"elf_bytes":std::fs::metadata("build/vault.so").unwrap().len()
    })).unwrap()).unwrap();
}

#[test]
fn vault_rejects_authority_mint_owner_alias_and_cpi_failures() {
    let mut f = Vault::new("vault");
    f.initialize();
    f.send(&[f.ix(1, 500)]).unwrap();
    let mut unsigned = f.ix(2, 1);
    unsigned.accounts[1].is_signer = false;
    f.reject(unsigned, Some(257));
    let mut attacker = f.ix(2, 1);
    attacker.accounts[1].pubkey = f.attacker.pubkey();
    f.reject(attacker, Some(257));
    let mut wrong_pda = f.ix(2, 1);
    wrong_pda.accounts[3].pubkey = f.attacker.pubkey();
    f.reject(wrong_pda, Some(11));
    let mut wrong_program = f.ix(2, 1);
    wrong_program.accounts[2].pubkey = Pubkey::default();
    f.reject(wrong_program, Some(10));
    let mut alias = f.ix(2, 1);
    alias.accounts[5] = alias.accounts[4].clone();
    f.reject(alias, Some(6));
    let mut readonly = f.ix(2, 1);
    readonly.accounts[5].is_writable = false;
    f.reject(readonly, Some(5));
    let original = f.svm.get_account(&f.user_token.pubkey()).unwrap();
    for (offset, code) in [(0, 15), (32, 17), (108, 14), (109, 14)] {
        let mut wrong = original.clone();
        wrong.data[offset] ^= 1;
        f.svm.set_account(f.user_token.pubkey(), wrong).unwrap();
        f.reject(f.ix(2, 1), Some(code));
    }
    let mut wrong = original.clone();
    wrong.owner = Pubkey::new_unique();
    f.svm.set_account(f.user_token.pubkey(), wrong).unwrap();
    f.reject(f.ix(2, 1), Some(13));
    f.svm.set_account(f.user_token.pubkey(), original).unwrap();
    // Accounting permits this deposit, but actual source funds are insufficient.
    f.reject(f.ix(1, 501), None);
    // Freeze with a real Token instruction, then exercise failed CPI rollback.
    let freeze = token::freeze_account(
        &spl_token::id(),
        &f.vault_token.pubkey(),
        &f.mint.pubkey(),
        &f.actor.pubkey(),
        &[],
    )
    .unwrap();
    f.send(&[freeze]).unwrap();
    f.reject(f.ix(2, 1), None);
}

#[test]
fn vault_handles_full_u64_and_rejects_overflow() {
    let mut f = Vault::new("vault");
    f.initialize();
    let mint = token::mint_to(
        &spl_token::id(),
        &f.mint.pubkey(),
        &f.user_token.pubkey(),
        &f.actor.pubkey(),
        &[],
        u64::MAX - 1000,
    )
    .unwrap();
    f.send(&[mint]).unwrap();
    f.send(&[f.ix(1, u64::MAX)]).unwrap();
    assert_eq!(f.ledger(), u64::MAX);
    assert_eq!(f.balances(), (0, u64::MAX));
    f.reject(f.ix(1, 1), Some(260));
    f.send(&[f.ix(2, u64::MAX)]).unwrap();
    assert_eq!(f.ledger(), 0);
    assert_eq!(f.balances(), (u64::MAX, 0));
}

#[test]
fn vault_initialization_checks_mint_and_rolls_back_creation() {
    let mut f = Vault::new("vault");
    let mut init = f.ix(0, 0);
    init.data[3] ^= 1; // Claimed mint differs from the passed mint account.
    let error = f
        .send(&[f.create(f.state.pubkey(), f.size, f.program), init])
        .unwrap_err();
    assert_eq!(
        error.err,
        TransactionError::InstructionError(1, InstructionError::Custom(15))
    );
    assert!(f.svm.get_account(&f.state.pubkey()).is_none());
    assert_eq!(f.balances(), (1000, 0));
    f.initialize();
    f.reject(f.ix(0, 0), Some(4));
}

#[test]
fn shared_two_leg_executor_rolls_back_first_transfer_when_second_cpi_fails() {
    let mut f = Vault::new("vault");
    f.svm
        .add_program_from_file(f.program, "build/settlement.so")
        .unwrap();
    let interface: serde_json::Value =
        serde_json::from_slice(&std::fs::read("build/settlement.interface.json").unwrap()).unwrap();
    f.size = interface["stateBytes"].as_u64().unwrap() as usize;
    let roundtrip = |f: &Vault, initialize: bool, deposit: u64, withdrawal: u64| {
        let mut ix = f.ix(1, 0);
        ix.accounts[0].is_signer = initialize;
        ix.data = vec![if initialize { 0 } else { 1 }, 0, 0];
        ix.data.extend(f.mint.pubkey().to_bytes());
        ix.data.push(0);
        ix.data.extend(deposit.to_le_bytes());
        ix.data.push(0);
        ix.data.extend(withdrawal.to_le_bytes());
        ix
    };
    f.send(&[
        f.create(f.state.pubkey(), f.size, f.program),
        roundtrip(&f, true, 0, 0),
    ])
    .unwrap();
    f.send(&[roundtrip(&f, false, 100, 40)]).unwrap();
    assert_eq!(f.balances(), (940, 60));
    let before = f.snapshot();
    // First leg can deposit 100. The resulting 160 cannot cover the second leg.
    let error = f.send(&[roundtrip(&f, false, 100, 161)]).unwrap_err();
    let token_prefix = format!("Program {}", spl_token::id());
    assert_eq!(
        error
            .meta
            .logs
            .iter()
            .filter(|line| line.as_str() == "Program log: Instruction: TransferChecked")
            .count(),
        2,
        "{:?}",
        error.meta.logs
    );
    assert!(error
        .meta
        .logs
        .iter()
        .any(|line| line == &format!("{token_prefix} success")));
    assert!(error
        .meta
        .logs
        .iter()
        .any(|line| line.starts_with(&format!("{token_prefix} failed:"))));
    assert_eq!(
        f.snapshot(),
        before,
        "first transfer or state escaped rollback"
    );
    f.send(&[roundtrip(&f, false, 0, 60)]).unwrap();
    assert_eq!(f.balances(), (1000, 0));
}
