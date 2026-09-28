use super::*;
use solana_program_pack::Pack;
use solana_system_interface::instruction as system;
use spl_token::{
    instruction as token,
    state::{Account as TokenAccount, Mint},
};

pub(super) struct TokenFixture {
    pub(super) svm: LiteSVM,
    pub(super) program: Pubkey,
    pub(super) state: Keypair,
    pub(super) payer: Keypair,
    pub(super) actor: Keypair,
    pub(super) attacker: Keypair,
    pub(super) custody: Pubkey,
    pub(super) mint: Keypair,
    pub(super) user_token: Keypair,
    pub(super) vault_token: Keypair,
    pub(super) header: Vec<u8>,
    pub(super) size: usize,
    pub(super) max_cu: u64,
}
impl TokenFixture {
    pub(super) fn new(stem: &str) -> Self {
        Self::with_program(stem, &format!("build/{stem}.so"))
    }
    pub(super) fn with_program(stem: &str, elf: &str) -> Self {
        Self::with_program_seeded(stem, elf, false)
    }
    pub(super) fn with_program_seeded(stem: &str, elf: &str, deterministic: bool) -> Self {
        Self::with_program_seeded_interface(
            elf,
            deterministic,
            &format!("build/{stem}.interface.json"),
        )
    }
    pub(super) fn with_program_seeded_interface(
        elf: &str,
        deterministic: bool,
        interface_path: &str,
    ) -> Self {
        let key = |marker| {
            if deterministic {
                Keypair::new_from_array([marker; 32])
            } else {
                Keypair::new()
            }
        };
        let interface: serde_json::Value =
            serde_json::from_slice(&std::fs::read(interface_path).unwrap()).unwrap();
        let primary = if interface["version"] == 2 {
            &interface["stateAccounts"][0]
        } else {
            &interface
        };
        let mut svm = LiteSVM::new().with_transaction_history(0);
        let program = if deterministic {
            Pubkey::new_from_array([42; 32])
        } else {
            Pubkey::new_unique()
        };
        svm.add_program_from_file(program, elf).unwrap();
        let state = key(1);
        let (custody, _) =
            Pubkey::find_program_address(&[b"bend", state.pubkey().as_ref()], &program);
        let payer = key(2);
        let actor = key(3);
        let attacker = key(4);
        for key in [payer.pubkey(), actor.pubkey(), attacker.pubkey(), custody] {
            svm.airdrop(&key, 1_000_000_000).unwrap();
        }
        let mut f = Self {
            svm,
            program,
            state,
            payer,
            actor,
            attacker,
            custody,
            mint: key(5),
            user_token: key(6),
            vault_token: key(7),
            header: serde_json::from_value(primary["header"].clone()).unwrap(),
            size: primary["stateBytes"].as_u64().unwrap() as usize,
            max_cu: 0,
        };
        let mut setup = vec![
            f.create(f.mint.pubkey(), Mint::LEN, spl_token::id()),
            token::initialize_mint2(
                &spl_token::id(),
                &f.mint.pubkey(),
                &f.actor.pubkey(),
                Some(&f.actor.pubkey()),
                6,
            )
            .unwrap(),
        ];
        for (account, owner) in [
            (f.user_token.pubkey(), f.actor.pubkey()),
            (f.vault_token.pubkey(), f.custody),
        ] {
            setup.push(f.create(account, TokenAccount::LEN, spl_token::id()));
            setup.push(
                token::initialize_account3(&spl_token::id(), &account, &f.mint.pubkey(), &owner)
                    .unwrap(),
            );
        }
        setup.push(
            token::mint_to(
                &spl_token::id(),
                &f.mint.pubkey(),
                &f.user_token.pubkey(),
                &f.actor.pubkey(),
                &[],
                1000,
            )
            .unwrap(),
        );
        f.send(&setup).unwrap();
        f.max_cu = 0;
        f
    }
    pub(super) fn create(&self, key: Pubkey, size: usize, owner: Pubkey) -> Instruction {
        system::create_account(
            &self.payer.pubkey(),
            &key,
            self.svm.minimum_balance_for_rent_exemption(size),
            size as u64,
            &owner,
        )
    }
    pub(super) fn send(&mut self, ixs: &[Instruction]) -> TransactionResult {
        self.send_extra(ixs, &[])
    }
    pub(super) fn send_extra(
        &mut self,
        ixs: &[Instruction],
        extra: &[&Keypair],
    ) -> TransactionResult {
        let mut signers = vec![&self.payer];
        signers.extend_from_slice(extra);
        for key in [
            &self.actor,
            &self.attacker,
            &self.state,
            &self.mint,
            &self.user_token,
            &self.vault_token,
        ] {
            if ixs.iter().any(|ix| {
                ix.accounts
                    .iter()
                    .any(|m| m.is_signer && m.pubkey == key.pubkey())
            }) {
                signers.push(key);
            }
        }
        let tx = Transaction::new(
            &signers,
            Message::new(ixs, Some(&self.payer.pubkey())),
            self.svm.latest_blockhash(),
        );
        let result = self.svm.send_transaction(tx);
        if let Ok(meta) = &result {
            self.max_cu = self.max_cu.max(meta.compute_units_consumed);
        }
        result
    }
    pub(super) fn balances(&self) -> (u64, u64) {
        let balance = |key| {
            TokenAccount::unpack(&self.svm.get_account(&key).unwrap().data)
                .unwrap()
                .amount
        };
        (
            balance(self.user_token.pubkey()),
            balance(self.vault_token.pubkey()),
        )
    }
    pub(super) fn snapshot(&self) -> Vec<Option<Account>> {
        [
            self.state.pubkey(),
            self.user_token.pubkey(),
            self.vault_token.pubkey(),
            self.mint.pubkey(),
        ]
        .iter()
        .map(|key| self.svm.get_account(key))
        .collect()
    }
    pub(super) fn reject(&mut self, ix: Instruction, code: Option<u32>) {
        let before = self.snapshot();
        let error = self.send(&[ix]).unwrap_err();
        if let Some(code) = code {
            assert_eq!(
                error.err,
                TransactionError::InstructionError(0, InstructionError::Custom(code)),
                "{:?}",
                error.meta.logs
            );
        }
        assert_eq!(
            self.snapshot(),
            before,
            "failed instruction changed state or tokens"
        );
    }
}
