use super::token_fixture::TokenFixture;
use super::*;
use solana_program_pack::Pack;
use spl_token::{instruction as token, state::Account as TokenAccount};

struct BatchFixture {
    f: TokenFixture,
    owners: [Pubkey; 4],
    destinations: [Pubkey; 4],
}
impl BatchFixture {
    fn new() -> Self {
        let elf = std::env::var("BATCH_PROGRAM").unwrap_or_else(|_| "build/batch.so".into());
        let mut f = TokenFixture::with_program_seeded("batch", &elf, true);
        let owners = std::array::from_fn(|i| Pubkey::new_from_array([100 + i as u8; 32]));
        let destinations = std::array::from_fn(|i| {
            let key = Keypair::new_from_array([20 + i as u8; 32]);
            let setup = [
                f.create(key.pubkey(), TokenAccount::LEN, spl_token::id()),
                token::initialize_account3(
                    &spl_token::id(),
                    &key.pubkey(),
                    &f.mint.pubkey(),
                    &owners[i],
                )
                .unwrap(),
            ];
            f.send_extra(&setup, &[&key]).unwrap();
            key.pubkey()
        });
        f.max_cu = 0;
        Self {
            f,
            owners,
            destinations,
        }
    }
    fn prefix(&self, initialize: bool) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.f.state.pubkey(), initialize),
            AccountMeta::new_readonly(self.f.actor.pubkey(), true),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(self.f.custody, false),
        ]
    }
    fn initialize_ix(&self, length: u32, fuel: u32, amounts: [u64; 4]) -> Instruction {
        let mut data = vec![0, 0];
        for key in [self.f.mint.pubkey(), self.f.vault_token.pubkey()] {
            data.push(0);
            data.extend_from_slice(key.as_ref());
        }
        data.push(0);
        data.extend_from_slice(&length.to_le_bytes());
        data.push(0); // outer pair
        for (i, amount) in amounts.iter().enumerate() {
            if i % 2 == 0 {
                data.push(0);
            } // inner pair
            data.push(0); // obligation
            data.push(0);
            data.extend_from_slice(self.owners[i].as_ref());
            data.push(0);
            data.extend_from_slice(&amount.to_le_bytes());
        }
        data.extend_from_slice(&fuel.to_le_bytes());
        assert_eq!(data.len(), 252);
        let mut accounts = self.prefix(true);
        accounts.extend([
            AccountMeta::new(self.f.user_token.pubkey(), false),
            AccountMeta::new(self.f.vault_token.pubkey(), false),
            AccountMeta::new_readonly(self.f.mint.pubkey(), false),
        ]);
        Instruction {
            program_id: self.f.program,
            accounts,
            data,
        }
    }
    fn allocate(&mut self) {
        self.f
            .send(&[self
                .f
                .create(self.f.state.pubkey(), self.f.size, self.f.program)])
            .unwrap();
    }
    fn initialize(&mut self, length: u32, amounts: [u64; 4]) -> u64 {
        self.allocate();
        let ix = self.initialize_ix(length, length, amounts);
        self.f.send(&[ix]).unwrap().compute_units_consumed
    }
    fn settle_ix(&self, length: usize) -> Instruction {
        let mut data = vec![1, 1];
        data.resize(252, 0);
        let mut accounts = self.prefix(false);
        accounts.extend([
            AccountMeta::new(self.f.vault_token.pubkey(), false),
            AccountMeta::new_readonly(self.f.mint.pubkey(), false),
        ]);
        accounts.extend(
            self.destinations[..length]
                .iter()
                .map(|key| AccountMeta::new(*key, false)),
        );
        Instruction {
            program_id: self.f.program,
            accounts,
            data,
        }
    }
    fn balances(&self) -> Vec<u64> {
        [self.f.user_token.pubkey(), self.f.vault_token.pubkey()]
            .into_iter()
            .chain(self.destinations)
            .map(|key| {
                TokenAccount::unpack(&self.f.svm.get_account(&key).unwrap().data)
                    .unwrap()
                    .amount
            })
            .collect()
    }
    fn snapshot(&self) -> Vec<Option<Account>> {
        let mut values = self.f.snapshot();
        values.extend(
            self.destinations
                .iter()
                .map(|key| self.f.svm.get_account(key)),
        );
        values
    }
    fn reject(&mut self, ix: Instruction, code: u32) -> u64 {
        let before = self.snapshot();
        let error = self.f.send(&[ix]).unwrap_err();
        assert_eq!(
            error.err,
            TransactionError::InstructionError(0, InstructionError::Custom(code)),
            "{:?}",
            error.meta.logs
        );
        assert_eq!(self.snapshot(), before, "rejection changed state or tokens");
        error.meta.compute_units_consumed
    }
    fn state_tag(&self) -> u8 {
        let data = self.f.svm.get_account(&self.f.state.pubkey()).unwrap().data;
        assert_eq!(&data[..20], self.f.header);
        data[20]
    }
}

#[test]
fn batch_all_lengths_fund_settle_and_prevent_replay() {
    let mut metrics = vec![];
    for length in 1..=4 {
        let mut b = BatchFixture::new();
        let amounts = [10, 20, 30, 40];
        let total: u64 = amounts[..length].iter().sum();
        let funding_cu = b.initialize(length as u32, amounts);
        assert_eq!(b.state_tag(), 1);
        assert_eq!(b.f.balances(), (1000 - total, total));
        let settlement_cu =
            b.f.send(&[b.settle_ix(length)])
                .unwrap()
                .compute_units_consumed;
        let mut expected = vec![1000 - total, 0];
        expected.extend((0..4).map(|i| if i < length { amounts[i] } else { 0 }));
        assert_eq!(b.balances(), expected);
        assert_eq!(b.state_tag(), 2);
        let replay_cu = b.reject(b.settle_ix(length), 258);
        metrics.push(serde_json::json!({"length":length,"funding_cu":funding_cu,"settlement_cu":settlement_cu,"replay_cu":replay_cu}));
    }
    let output =
        std::env::var("BATCH_METRICS").unwrap_or_else(|_| "build/batch-metrics.json".into());
    std::fs::write(output, serde_json::to_vec_pretty(&metrics).unwrap()).unwrap();
}

#[test]
fn batch_rejects_bad_lengths_amounts_and_authorization() {
    let mut b = BatchFixture::new();
    b.allocate();
    for (length, fuel, amounts, code) in [
        (0, 0, [1, 2, 3, 4], 259),
        (5, 5, [1, 2, 3, 4], 259),
        (u32::MAX, 1, [1, 2, 3, 4], 259),
        (2, 1, [1, 2, 3, 4], 259),
        (1, 2, [1, 2, 3, 4], 259),
        (1, 65, [1, 2, 3, 4], 2),
        (1, 1, [0, 2, 3, 4], 259),
        (2, 2, [u64::MAX, 1, 0, 0], 260),
        (1, 1, [1001, 0, 0, 0], 1),
    ] {
        b.reject(b.initialize_ix(length, fuel, amounts), code);
    }
    let mut unsigned = b.initialize_ix(1, 1, [10, 0, 0, 0]);
    unsigned.accounts[1].is_signer = false;
    b.reject(unsigned, 257);
    b.f.send(&[b.initialize_ix(1, 1, [10, u64::MAX, 0, 0])])
        .unwrap(); // inactive overflow ignored
    let mut unauthorized = b.settle_ix(1);
    unauthorized.accounts[1].pubkey = b.f.attacker.pubkey();
    b.reject(unauthorized, 257);
    let mut unsigned = b.settle_ix(1);
    unsigned.accounts[1].is_signer = false;
    b.reject(unsigned, 257);
    let mut reinitialize = b.initialize_ix(1, 1, [10, 0, 0, 0]);
    reinitialize.data[0] = 1;
    reinitialize.accounts[0].is_signer = false;
    b.reject(reinitialize, 258);
}

#[test]
fn batch_late_cpi_failure_rolls_back_every_transfer() {
    for insufficient in [false, true] {
        let mut b = BatchFixture::new();
        b.initialize(4, [10, 20, 30, 40]);
        if insufficient {
            let key = b.f.vault_token.pubkey();
            let mut account = b.f.svm.get_account(&key).unwrap();
            let mut token = TokenAccount::unpack(&account.data).unwrap();
            token.amount = 79;
            TokenAccount::pack(token, &mut account.data).unwrap();
            b.f.svm.set_account(key, account).unwrap();
        } else {
            b.f.send(&[token::freeze_account(
                &spl_token::id(),
                &b.destinations[3],
                &b.f.mint.pubkey(),
                &b.f.actor.pubkey(),
                &[],
            )
            .unwrap()])
                .unwrap();
        }
        b.reject(b.settle_ix(4), if insufficient { 1 } else { 17 });
        assert_eq!(b.state_tag(), 1);
        assert_eq!(&b.balances()[2..], &[0, 0, 0, 0]);
    }
}

#[test]
fn batch_binds_custody_recipients_and_account_permissions() {
    let mut b = BatchFixture::new();
    b.initialize(2, [10, 20, 0, 0]);
    let mut swapped = b.settle_ix(2);
    swapped.accounts.swap(6, 7);
    b.reject(swapped, 17);
    let mut alias = b.settle_ix(2);
    alias.accounts[7].pubkey = alias.accounts[6].pubkey;
    b.reject(alias, 6);
    let mut readonly = b.settle_ix(2);
    readonly.accounts[7].is_writable = false;
    b.reject(readonly, 5);
    let mut source = b.settle_ix(2);
    source.accounts[4].pubkey = b.f.user_token.pubkey();
    b.reject(source, 25);
    let other_mint = Pubkey::new_from_array([88; 32]);
    b.f.svm
        .set_account(other_mint, b.f.svm.get_account(&b.f.mint.pubkey()).unwrap())
        .unwrap();
    let mut mint = b.settle_ix(2);
    mint.accounts[5].pubkey = other_mint;
    b.reject(mint, 15);
    let mut truncated = b.settle_ix(2);
    truncated.data.pop();
    b.reject(truncated, 2);
    let mut padding = b.settle_ix(2);
    padding.data[2] = 1;
    b.reject(padding, 2);
    b.f.send(&[b.settle_ix(2)]).unwrap();
}

#[test]
fn batch_settles_full_u64_total_without_truncation() {
    let mut b = BatchFixture::new();
    b.f.send(&[token::mint_to(
        &spl_token::id(),
        &b.f.mint.pubkey(),
        &b.f.user_token.pubkey(),
        &b.f.actor.pubkey(),
        &[],
        u64::MAX - 1000,
    )
    .unwrap()])
        .unwrap();
    b.initialize(4, [u64::MAX - 3, 1, 1, 1]);
    b.f.send(&[b.settle_ix(4)]).unwrap();
    assert_eq!(b.balances(), vec![0, 0, u64::MAX - 3, 1, 1, 1]);
}

#[test]
fn batch_checks_stored_total_and_does_not_distribute_donations() {
    let mut b = BatchFixture::new();
    b.initialize(4, [10, 20, 30, 40]);
    let key = b.f.state.pubkey();
    let original = b.f.svm.get_account(&key).unwrap();
    let mut altered = original.clone();
    let n = altered.data.len();
    altered.data[n - 8..].copy_from_slice(&99u64.to_le_bytes());
    b.f.svm.set_account(key, altered).unwrap();
    b.reject(b.settle_ix(4), 262);
    b.f.svm.set_account(key, original).unwrap();
    b.f.send(&[token::transfer_checked(
        &spl_token::id(),
        &b.f.user_token.pubkey(),
        &b.f.mint.pubkey(),
        &b.f.vault_token.pubkey(),
        &b.f.actor.pubkey(),
        &[],
        7,
        6,
    )
    .unwrap()])
        .unwrap();
    b.f.send(&[b.settle_ix(4)]).unwrap();
    assert_eq!(b.balances(), vec![893, 7, 10, 20, 30, 40]);
}

#[test]
fn batch_funding_binds_the_exact_custody_token_account() {
    let mut b = BatchFixture::new();
    b.allocate();
    let alternate = Keypair::new_from_array([89; 32]);
    b.f.send_extra(
        &[
            b.f.create(alternate.pubkey(), TokenAccount::LEN, spl_token::id()),
            token::initialize_account3(
                &spl_token::id(),
                &alternate.pubkey(),
                &b.f.mint.pubkey(),
                &b.f.custody,
            )
            .unwrap(),
        ],
        &[&alternate],
    )
    .unwrap();
    let before = b.f.svm.get_account(&alternate.pubkey());
    let mut ix = b.initialize_ix(1, 1, [10, 0, 0, 0]);
    ix.accounts[5].pubkey = alternate.pubkey();
    b.reject(ix, 25);
    assert_eq!(b.f.svm.get_account(&alternate.pubkey()), before);
}

fn benchmark_call(
    b: &mut BatchFixture,
    name: &str,
    ix: Instruction,
    error: Option<u32>,
) -> serde_json::Value {
    let accounts: Vec<_> = ix.accounts.iter().filter(|m|m.pubkey!=spl_token::id()).map(|meta| {
        let a=b.f.svm.get_account(&meta.pubkey).unwrap();
        serde_json::json!({"key":meta.pubkey.to_bytes(),"signer":meta.is_signer,"writable":meta.is_writable,
            "owner":a.owner.to_bytes(),"lamports":a.lamports,"data":a.data,"executable":a.executable})
    }).collect();
    let bytes = ix.data.clone();
    let cu = if let Some(code) = error {
        b.reject(ix, code)
    } else {
        b.f.send(&[ix]).unwrap().compute_units_consumed
    };
    let after: Vec<_>=b.snapshot().into_iter().map(|a|a.map(|a|serde_json::json!({"data":a.data,"lamports":a.lamports,"owner":a.owner.to_bytes()}))).collect();
    serde_json::json!({"name":name,"cu":cu,"error":error,"instruction":bytes,"accounts":accounts,"after":after})
}

#[test]
#[ignore = "run after building both implementations with benchmark:batch"]
fn batch_benchmark_fixed_fixtures() {
    let mut records = vec![];
    for length in 1..=4 {
        let mut b = BatchFixture::new();
        b.allocate();
        let ix = b.initialize_ix(length as u32, length as u32, [10, 20, 30, 40]);
        records.push(benchmark_call(&mut b, &format!("fund-{length}"), ix, None));
        let ix = b.settle_ix(length);
        records.push(benchmark_call(
            &mut b,
            &format!("settle-{length}"),
            ix,
            None,
        ));
        let ix = b.settle_ix(length);
        records.push(benchmark_call(
            &mut b,
            &format!("replay-{length}"),
            ix,
            Some(258),
        ));
    }
    for (name, length, fuel, amounts, code) in [
        ("empty", 0, 0, [0, 0, 0, 0], 259),
        ("bad-fuel", 4, 3, [10, 20, 30, 40], 259),
        ("overflow", 2, 2, [u64::MAX, 1, 0, 0], 260),
        ("funding-insufficient", 1, 1, [1001, 0, 0, 0], 1),
    ] {
        let mut b = BatchFixture::new();
        b.allocate();
        let ix = b.initialize_ix(length, fuel, amounts);
        records.push(benchmark_call(&mut b, name, ix, Some(code)));
    }
    let mut b = BatchFixture::new();
    b.initialize(4, [10, 20, 30, 40]);
    let mut ix = b.settle_ix(4);
    ix.accounts[1].pubkey = b.f.attacker.pubkey();
    records.push(benchmark_call(&mut b, "unauthorized", ix, Some(257)));
    b.f.send(&[token::freeze_account(
        &spl_token::id(),
        &b.destinations[3],
        &b.f.mint.pubkey(),
        &b.f.actor.pubkey(),
        &[],
    )
    .unwrap()])
        .unwrap();
    let ix = b.settle_ix(4);
    records.push(benchmark_call(&mut b, "late-frozen", ix, Some(17)));
    std::fs::write(
        std::env::var("BATCH_METRICS").expect("BATCH_METRICS"),
        serde_json::to_vec_pretty(&records).unwrap(),
    )
    .unwrap();
}
