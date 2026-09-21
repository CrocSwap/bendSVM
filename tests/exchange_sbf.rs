use super::token_fixture::TokenFixture;
use super::*;
use solana_program_pack::Pack;
use spl_token::{
    instruction as token,
    state::{Account as TokenAccount, Mint},
};

struct Exchange {
    f: TokenFixture,
    quote: Pubkey,
    buyer_quote: Pubkey,
    maker_quote: Pubkey,
    buyer_base: Pubkey,
}
impl Exchange {
    fn new() -> Self {
        let mut f = TokenFixture::new("exchange");
        let quote = Keypair::new();
        let ixs = [
            f.create(quote.pubkey(), Mint::LEN, spl_token::id()),
            token::initialize_mint2(
                &spl_token::id(),
                &quote.pubkey(),
                &f.actor.pubkey(),
                Some(&f.actor.pubkey()),
                6,
            )
            .unwrap(),
        ];
        f.send_extra(&ixs, &[&quote]).unwrap();
        let buyer_quote = create_token(&mut f, quote.pubkey(), None);
        let owner = f.actor.pubkey();
        let maker_quote = create_token(&mut f, quote.pubkey(), Some(owner));
        let mint = f.mint.pubkey();
        let buyer_base = create_token(&mut f, mint, None);
        let mint = token::mint_to(
            &spl_token::id(),
            &quote.pubkey(),
            &buyer_quote,
            &f.actor.pubkey(),
            &[],
            10_000,
        )
        .unwrap();
        f.send(&[mint]).unwrap();
        f.max_cu = 0;
        Self {
            f,
            quote: quote.pubkey(),
            buyer_quote,
            maker_quote,
            buyer_base,
        }
    }
    fn prefix(&self, actor: Pubkey, init: bool) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.f.state.pubkey(), init),
            AccountMeta::new_readonly(actor, true),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(self.f.custody, false),
        ]
    }
    fn init(&self, amount: u64, numerator: u64, denominator: u64) -> Instruction {
        let mut data = vec![0, 0, 0];
        data.extend(self.f.mint.pubkey().to_bytes());
        data.push(0);
        data.extend(self.quote.to_bytes());
        for n in [amount, numerator, denominator] {
            data.push(0);
            data.extend(n.to_le_bytes());
        }
        let mut accounts = self.prefix(self.f.actor.pubkey(), true);
        accounts.extend([
            AccountMeta::new(self.f.user_token.pubkey(), false),
            AccountMeta::new(self.f.vault_token.pubkey(), false),
            AccountMeta::new_readonly(self.f.mint.pubkey(), false),
            AccountMeta::new_readonly(self.quote, false),
        ]);
        Instruction {
            program_id: self.f.program,
            accounts,
            data,
        }
    }
    fn initialize(&mut self, amount: u64, numerator: u64, denominator: u64) {
        self.f
            .send(&[
                self.f
                    .create(self.f.state.pubkey(), self.f.size, self.f.program),
                self.init(amount, numerator, denominator),
            ])
            .unwrap();
    }
    fn fill(&self, amount: u64, maximum: u64) -> Instruction {
        let mut data = vec![1, 1];
        for n in [amount, maximum] {
            data.push(0);
            data.extend(n.to_le_bytes());
        }
        data.resize(95, 0);
        let mut accounts = self.prefix(self.f.attacker.pubkey(), false);
        accounts.extend([
            AccountMeta::new(self.buyer_quote, false),
            AccountMeta::new(self.maker_quote, false),
            AccountMeta::new_readonly(self.quote, false),
            AccountMeta::new(self.f.vault_token.pubkey(), false),
            AccountMeta::new(self.buyer_base, false),
            AccountMeta::new_readonly(self.f.mint.pubkey(), false),
        ]);
        Instruction {
            program_id: self.f.program,
            accounts,
            data,
        }
    }
    fn cancel(&self) -> Instruction {
        let mut data = vec![1, 2];
        data.resize(95, 0);
        let mut accounts = self.prefix(self.f.actor.pubkey(), false);
        accounts.extend([
            AccountMeta::new(self.f.vault_token.pubkey(), false),
            AccountMeta::new(self.f.user_token.pubkey(), false),
            AccountMeta::new_readonly(self.f.mint.pubkey(), false),
        ]);
        Instruction {
            program_id: self.f.program,
            accounts,
            data,
        }
    }
    fn remaining(&self) -> Option<u64> {
        let data = self.f.svm.get_account(&self.f.state.pubkey()).unwrap().data;
        assert_eq!(&data[..20], self.f.header);
        if data[20] == 2 {
            assert!(data[21..].iter().all(|b| *b == 0));
            return None;
        }
        assert_eq!(data[20], 1);
        assert_eq!(data.len(), 148);
        Some(u64::from_le_bytes(data[122..130].try_into().unwrap()))
    }
    fn amounts(&self) -> [u64; 5] {
        [
            self.f.user_token.pubkey(),
            self.f.vault_token.pubkey(),
            self.buyer_base,
            self.maker_quote,
            self.buyer_quote,
        ]
        .map(|key| balance(&self.f, key))
    }
    fn snapshot(&self) -> Vec<Option<Account>> {
        let mut result = self.f.snapshot();
        result.extend(
            [
                self.quote,
                self.buyer_quote,
                self.maker_quote,
                self.buyer_base,
            ]
            .map(|key| self.f.svm.get_account(&key)),
        );
        result
    }
    fn reject(
        &mut self,
        ix: Instruction,
        code: Option<u32>,
    ) -> litesvm::types::FailedTransactionMetadata {
        let before = self.snapshot();
        let error = self.f.send(&[ix]).unwrap_err();
        if let Some(code) = code {
            assert_eq!(
                error.err,
                TransactionError::InstructionError(0, InstructionError::Custom(code)),
                "{:?}",
                error.meta.logs
            );
        }
        assert_eq!(self.snapshot(), before);
        error
    }
}
fn create_token(f: &mut TokenFixture, mint: Pubkey, owner: Option<Pubkey>) -> Pubkey {
    let account = Keypair::new();
    let ixs = [
        f.create(account.pubkey(), TokenAccount::LEN, spl_token::id()),
        token::initialize_account3(
            &spl_token::id(),
            &account.pubkey(),
            &mint,
            &owner.unwrap_or(f.attacker.pubkey()),
        )
        .unwrap(),
    ];
    f.send_extra(&ixs, &[&account]).unwrap();
    account.pubkey()
}
fn balance(f: &TokenFixture, key: Pubkey) -> u64 {
    TokenAccount::unpack(&f.svm.get_account(&key).unwrap().data)
        .unwrap()
        .amount
}

#[test]
fn exchange_validation_matrix() {
    let mut e = Exchange::new();
    e.initialize(100, 1, 1);
    let ix = e.fill(1, 1);
    super::validation::matrix(&mut e.f, ix, &[(4, 5, 6), (7, 8, 9)], 16, "exchange");
    assert_eq!(e.remaining(), Some(99));
    assert_eq!(e.amounts(), [900, 99, 1, 1, 9999]);
}

#[test]
fn exchange_partial_fills_round_up_and_cancel_returns_unsold_tokens() {
    let mut e = Exchange::new();
    e.initialize(600, 2, 3);
    assert_eq!(e.amounts(), [400, 600, 0, 0, 10_000]);
    e.f.send(&[e.fill(100, 67)]).unwrap();
    assert_eq!(e.remaining(), Some(500));
    assert_eq!(e.amounts(), [400, 500, 100, 67, 9933]);
    e.reject(e.fill(100, 66), Some(261));
    e.f.send(&[e.fill(1, 1)]).unwrap();
    e.f.send(&[e.fill(2, 2)]).unwrap();
    assert_eq!(e.remaining(), Some(497));
    assert_eq!(e.amounts(), [400, 497, 103, 70, 9930]);
    let mut stranger = e.cancel();
    stranger.accounts[1].pubkey = e.f.attacker.pubkey();
    e.reject(stranger, Some(257));
    e.f.send(&[e.cancel()]).unwrap();
    assert_eq!(e.remaining(), None);
    assert_eq!(e.amounts(), [897, 0, 103, 70, 9930]);
    e.reject(e.fill(1, 1), Some(263));
    e.reject(e.cancel(), Some(263));
    println!("Exchange lifecycle passed; max {} CU", e.f.max_cu);
    std::fs::write("build/exchange-metrics.json",serde_json::to_vec_pretty(&serde_json::json!({
        "max_cu_including_creation":e.f.max_cu,"elf_bytes":std::fs::metadata("build/exchange.so").unwrap().len()
    })).unwrap()).unwrap();
}

#[test]
fn exchange_full_fill_closes_and_rejects_overfill_zero_and_unsigned() {
    let mut e = Exchange::new();
    e.initialize(10, 3, 2);
    e.reject(e.fill(0, 100), Some(260));
    e.reject(e.fill(11, 100), Some(260));
    let mut unsigned = e.fill(1, 2);
    unsigned.accounts[1].is_signer = false;
    e.reject(unsigned, Some(257));
    e.f.send(&[e.fill(10, 15)]).unwrap();
    assert_eq!(e.remaining(), None);
    assert_eq!(e.amounts(), [990, 0, 10, 15, 9985]);
    e.reject(e.fill(1, 2), Some(263));
}

#[test]
fn exchange_rejects_bad_offers_and_funding_atomically() {
    let mut e = Exchange::new();
    for (qty, num, den, code) in [
        (0, 1, 1, Some(259)),
        (1, 0, 1, Some(259)),
        (1, 1, 0, Some(259)),
        (1001, 1, 1, None),
    ] {
        let before = e.snapshot();
        let error =
            e.f.send(&[
                e.f.create(e.f.state.pubkey(), e.f.size, e.f.program),
                e.init(qty, num, den),
            ])
            .unwrap_err();
        if let Some(code) = code {
            assert_eq!(
                error.err,
                TransactionError::InstructionError(1, InstructionError::Custom(code))
            );
        }
        assert_eq!(e.snapshot(), before);
    }
    let mut same = e.init(1, 1, 1);
    same.data[36..68].copy_from_slice(e.f.mint.pubkey().as_ref());
    let error =
        e.f.send(&[e.f.create(e.f.state.pubkey(), e.f.size, e.f.program), same])
            .unwrap_err();
    assert_eq!(
        error.err,
        TransactionError::InstructionError(1, InstructionError::Custom(259))
    );
    assert!(e.f.svm.get_account(&e.f.state.pubkey()).is_none());
}

#[test]
fn exchange_rejects_account_substitution_and_rolls_back_second_leg_failure() {
    let mut e = Exchange::new();
    e.initialize(100, 1, 1);
    let mut alias = e.fill(1, 1);
    alias.accounts[5] = alias.accounts[4].clone();
    e.reject(alias, Some(6));
    let mut wrong_mint = e.fill(1, 1);
    wrong_mint.accounts[6].pubkey = e.f.mint.pubkey();
    // Avoid a duplicate mint alias so the expected-mint check is exercised.
    wrong_mint.accounts.pop();
    e.reject(wrong_mint, Some(15));
    let original = e.f.svm.get_account(&e.maker_quote).unwrap();
    let mut wrong = original.clone();
    wrong.data[32..64].copy_from_slice(e.f.attacker.pubkey().as_ref());
    e.f.svm.set_account(e.maker_quote, wrong).unwrap();
    e.reject(e.fill(1, 1), Some(17));
    e.f.svm.set_account(e.maker_quote, original).unwrap();
    let mut padding = e.fill(1, 1);
    padding.data[94] = 1;
    e.reject(padding, Some(2));
    let state = e.f.svm.get_account(&e.f.state.pubkey()).unwrap();
    let mut wrong = state.clone();
    wrong.owner = Pubkey::new_unique();
    e.f.svm.set_account(e.f.state.pubkey(), wrong).unwrap();
    e.reject(e.fill(1, 1), Some(3));
    e.f.svm.set_account(e.f.state.pubkey(), state).unwrap();
    let freeze = token::freeze_account(
        &spl_token::id(),
        &e.buyer_base,
        &e.f.mint.pubkey(),
        &e.f.actor.pubkey(),
        &[],
    )
    .unwrap();
    e.f.send(&[freeze]).unwrap();
    let error = e.reject(e.fill(10, 10), None);
    assert_eq!(
        error
            .meta
            .logs
            .iter()
            .filter(|l| l.as_str() == "Program log: Instruction: TransferChecked")
            .count(),
        2
    );
    assert!(error
        .meta
        .logs
        .iter()
        .any(|l| l == &format!("Program {} success", spl_token::id())));
    assert!(error
        .meta
        .logs
        .iter()
        .any(|l| l.starts_with(&format!("Program {} failed:", spl_token::id()))));
    assert_eq!(e.amounts(), [900, 100, 0, 0, 10_000]);
}

#[test]
fn exchange_full_width_price_succeeds_and_overflow_rejects() {
    let mut e = Exchange::new();
    e.initialize(100, u64::MAX, u64::MAX);
    e.f.send(&[e.fill(100, 100)]).unwrap();
    assert_eq!(e.amounts(), [900, 0, 100, 100, 9900]);
    let mut e = Exchange::new();
    e.initialize(100, u64::MAX, 1);
    e.reject(e.fill(2, u64::MAX), Some(262));
    // One unit's quote fits but actual buyer funds do not; state is unchanged.
    e.reject(e.fill(1, u64::MAX), None);
    e.f.send(&[e.cancel()]).unwrap();
    assert_eq!(e.amounts(), [1000, 0, 0, 0, 10_000]);
}

fn vault_ix(
    e: &Exchange,
    program: Pubkey,
    state: Pubkey,
    custody: Pubkey,
    vault_token: Pubkey,
    op: u8,
    amount: u64,
) -> Instruction {
    let mut data = vec![if op == 0 { 0 } else { 1 }, op, 0];
    if op == 0 {
        data.extend(e.f.mint.pubkey().to_bytes());
    } else {
        data.extend(amount.to_le_bytes());
        data.resize(35, 0);
    }
    let mut accounts = vec![
        AccountMeta::new(state, op == 0),
        AccountMeta::new_readonly(e.f.attacker.pubkey(), true),
        AccountMeta::new_readonly(spl_token::id(), false),
        AccountMeta::new_readonly(custody, false),
    ];
    if op == 0 {
        accounts.push(AccountMeta::new_readonly(e.f.mint.pubkey(), false));
    } else {
        let (src, dst) = if op == 1 {
            (e.buyer_base, vault_token)
        } else {
            (vault_token, e.buyer_base)
        };
        accounts.extend([
            AccountMeta::new(src, false),
            AccountMeta::new(dst, false),
            AccountMeta::new_readonly(e.f.mint.pubkey(), false),
        ]);
    }
    Instruction {
        program_id: program,
        accounts,
        data,
    }
}

#[test]
fn exchange_vault_and_vesting_compose_and_cross_program_failures_are_atomic() {
    let mut e = Exchange::new();
    e.initialize(600, 2, 3);
    let mint = e.f.mint.pubkey();
    let vault_program = Pubkey::new_unique();
    let vault_state = Keypair::new();
    e.f.svm
        .add_program_from_file(vault_program, "build/vault.so")
        .unwrap();
    let (vault_custody, _) =
        Pubkey::find_program_address(&[b"bend", vault_state.pubkey().as_ref()], &vault_program);
    e.f.svm.airdrop(&vault_custody, 1_000_000_000).unwrap();
    let vault_token = create_token(&mut e.f, mint, Some(vault_custody));
    let vault_layout: serde_json::Value =
        serde_json::from_slice(&std::fs::read("build/vault.interface.json").unwrap()).unwrap();
    let init = vault_ix(
        &e,
        vault_program,
        vault_state.pubkey(),
        vault_custody,
        vault_token,
        0,
        0,
    );
    e.f.send_extra(
        &[
            e.f.create(
                vault_state.pubkey(),
                vault_layout["stateBytes"].as_u64().unwrap() as usize,
                vault_program,
            ),
            init,
        ],
        &[&vault_state],
    )
    .unwrap();
    let before = e.snapshot();
    let before_vault = e.f.svm.get_account(&vault_state.pubkey());
    // The purchase succeeds, but the next program cannot deposit 101 purchased
    // tokens when only 100 were bought. Every exchange/token/state change rolls back.
    let deposit = vault_ix(
        &e,
        vault_program,
        vault_state.pubkey(),
        vault_custody,
        vault_token,
        1,
        101,
    );
    let error = e.f.send(&[e.fill(100, 67), deposit]).unwrap_err();
    assert!(matches!(
        error.err,
        TransactionError::InstructionError(1, _)
    ));
    assert!(error
        .meta
        .logs
        .iter()
        .any(|l| l == &format!("Program {} success", e.f.program)));
    assert_eq!(e.snapshot(), before);
    assert_eq!(e.f.svm.get_account(&vault_state.pubkey()), before_vault);
    assert_eq!(balance(&e.f, vault_token), 0);
    let deposit = vault_ix(
        &e,
        vault_program,
        vault_state.pubkey(),
        vault_custody,
        vault_token,
        1,
        100,
    );
    e.f.send(&[e.fill(100, 67), deposit]).unwrap();
    assert_eq!(e.amounts(), [400, 500, 0, 67, 9933]);
    assert_eq!(balance(&e.f, vault_token), 100);

    let vesting_program = Pubkey::new_unique();
    let vesting_state = Keypair::new();
    e.f.svm
        .add_program_from_file(vesting_program, "build/vesting.so")
        .unwrap();
    let (vesting_custody, _) = Pubkey::find_program_address(
        &[b"bend", vesting_state.pubkey().as_ref()],
        &vesting_program,
    );
    e.f.svm.airdrop(&vesting_custody, 1_000_000_000).unwrap();
    let vesting_token = create_token(&mut e.f, mint, Some(vesting_custody));
    let vesting_layout: serde_json::Value =
        serde_json::from_slice(&std::fs::read("build/vesting.interface.json").unwrap()).unwrap();
    let mut data = vec![0, 0, 0];
    data.extend(e.f.actor.pubkey().to_bytes());
    data.push(0);
    data.extend(mint.to_bytes());
    for n in [50u64, 10, 20] {
        data.push(0);
        data.extend(n.to_le_bytes());
    }
    let fund = Instruction {
        program_id: vesting_program,
        data,
        accounts: vec![
            AccountMeta::new(vesting_state.pubkey(), true),
            AccountMeta::new_readonly(e.f.attacker.pubkey(), true),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(vesting_custody, false),
            AccountMeta::new(e.buyer_base, false),
            AccountMeta::new(vesting_token, false),
            AccountMeta::new_readonly(mint, false),
        ],
    };
    let withdraw = vault_ix(
        &e,
        vault_program,
        vault_state.pubkey(),
        vault_custody,
        vault_token,
        2,
        50,
    );
    e.f.send_extra(
        &[
            withdraw,
            e.f.create(
                vesting_state.pubkey(),
                vesting_layout["stateBytes"].as_u64().unwrap() as usize,
                vesting_program,
            ),
            fund,
        ],
        &[&vesting_state],
    )
    .unwrap();
    assert_eq!(balance(&e.f, vault_token), 50);
    assert_eq!(balance(&e.f, vesting_token), 50);
    assert_eq!(balance(&e.f, e.buyer_base), 0);
    e.f.svm.warp_to_slot(20);
    let mut data = vec![1, 1];
    data.resize(95, 0);
    let claim = Instruction {
        program_id: vesting_program,
        data,
        accounts: vec![
            AccountMeta::new(vesting_state.pubkey(), false),
            AccountMeta::new_readonly(e.f.actor.pubkey(), true),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(vesting_custody, false),
            AccountMeta::new(vesting_token, false),
            AccountMeta::new(e.f.user_token.pubkey(), false),
            AccountMeta::new_readonly(mint, false),
        ],
    };
    e.f.send(&[claim]).unwrap();
    assert_eq!(e.amounts(), [450, 500, 0, 67, 9933]);
    assert_eq!(balance(&e.f, vault_token), 50);
    assert_eq!(balance(&e.f, vesting_token), 0);
    // All base supply is accounted for after traversing three separate programs.
    assert_eq!(
        e.amounts()[0]
            + e.amounts()[1]
            + e.amounts()[2]
            + balance(&e.f, vault_token)
            + balance(&e.f, vesting_token),
        1000
    );
}
