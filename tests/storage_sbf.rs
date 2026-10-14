use super::*;

struct Storage {
    svm: LiteSVM,
    program: Pubkey,
    state: Keypair,
    payer: Keypair,
    actor: Keypair,
    attacker: Keypair,
    header: Vec<u8>,
    size: usize,
    max_cu: u64,
}
impl Storage {
    fn new() -> Self {
        let interface: serde_json::Value =
            serde_json::from_slice(&std::fs::read("build/storage.interface.json").unwrap())
                .unwrap();
        let mut svm = crate::test_svm().with_transaction_history(0);
        let program = Pubkey::new_unique();
        svm.add_program_from_file(program, "build/storage.so")
            .unwrap();
        let payer = Keypair::new();
        let actor = Keypair::new();
        let attacker = Keypair::new();
        for key in [&payer, &actor, &attacker] {
            svm.airdrop(&key.pubkey(), 1_000_000_000).unwrap();
        }
        Self {
            svm,
            program,
            state: Keypair::new(),
            payer,
            actor,
            attacker,
            header: serde_json::from_value(interface["header"].clone()).unwrap(),
            size: interface["stateBytes"].as_u64().unwrap() as usize,
            max_cu: 0,
        }
    }
    fn ix(&self, initialize: bool, value: u32) -> Instruction {
        let mut data = vec![
            if initialize { 0 } else { 1 },
            if initialize { 0 } else { 1 },
        ];
        data.extend(value.to_le_bytes());
        Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new(self.state.pubkey(), initialize),
                AccountMeta::new_readonly(self.actor.pubkey(), true),
            ],
            data,
        }
    }
    fn send(&mut self, ixs: &[Instruction]) -> TransactionResult {
        let mut signers = vec![&self.payer];
        for key in [&self.state, &self.actor, &self.attacker] {
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
    fn create(&self) -> Instruction {
        solana_system_interface::instruction::create_account(
            &self.payer.pubkey(),
            &self.state.pubkey(),
            self.svm.minimum_balance_for_rent_exemption(self.size),
            self.size as u64,
            &self.program,
        )
    }
    fn reject(&mut self, ix: Instruction, code: u32) {
        let before = self.svm.get_account(&self.state.pubkey());
        let err = self.send(&[ix]).unwrap_err();
        assert_eq!(
            err.err,
            TransactionError::InstructionError(0, InstructionError::Custom(code)),
            "{:?}",
            err.meta.logs
        );
        assert_eq!(self.svm.get_account(&self.state.pubkey()), before);
    }
    fn expected(&self, value: u32, slot: u64) -> Vec<u8> {
        let mut data = self.header.clone();
        data.extend([1, 0]); // Stored and Key constructors
        data.extend(self.actor.pubkey().to_bytes());
        data.extend(value.to_le_bytes());
        data.push(0); // U64 constructor
        data.extend(slot.to_le_bytes());
        assert_eq!(data.len(), self.size);
        data
    }
}

#[test]
fn shared_storage_initializes_updates_and_authenticates() {
    let mut f = Storage::new();
    f.svm.warp_to_slot(123);
    let init = f.ix(true, 42);
    let create = f.create();
    f.send(&[create, init]).unwrap();
    assert_eq!(
        f.svm.get_account(&f.state.pubkey()).unwrap().data,
        f.expected(42, 123)
    );
    let slot = (1u64 << 32) + 7;
    f.svm.warp_to_slot(slot);
    let meta = f.send(&[f.ix(false, u32::MAX)]).unwrap();
    let expected = f.expected(u32::MAX, slot);
    assert_eq!(f.svm.get_account(&f.state.pubkey()).unwrap().data, expected);
    assert_eq!(meta.return_data.data, expected[f.header.len()..]);
    assert_eq!(meta.return_data.program_id, f.program);
    let mut unsigned = f.ix(false, 0);
    unsigned.accounts[1].is_signer = false;
    f.reject(unsigned, 257);
    let mut attack = f.ix(false, 0);
    attack.accounts[1].pubkey = f.attacker.pubkey();
    f.reject(attack, 257);
    // Compare all eight limbs of a public key, not just a prefix.
    for i in 0..32 {
        let mut malformed = f.svm.get_account(&f.state.pubkey()).unwrap();
        malformed.data[f.header.len() + 2 + i] ^= 1;
        let original = f.svm.get_account(&f.state.pubkey()).unwrap();
        f.svm.set_account(f.state.pubkey(), malformed).unwrap();
        f.reject(f.ix(false, 0), 257);
        f.svm.set_account(f.state.pubkey(), original).unwrap();
    }
    f.reject(f.ix(true, 0), 4);
    let mut reinitialize = f.ix(false, 0);
    reinitialize.data[1] = 0;
    f.reject(reinitialize, 259);
    println!("Shared storage lifecycle passed; max {} CU", f.max_cu);
    std::fs::write(
        "build/storage-metrics.json",
        serde_json::to_vec_pretty(&serde_json::json!({
            "max_cu_including_creation": f.max_cu,
            "elf_bytes": std::fs::metadata("build/storage.so").unwrap().len()
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn shared_storage_rejects_malformed_accounts_and_instructions() {
    let mut f = Storage::new();
    f.send(&[f.create(), f.ix(true, 42)]).unwrap();
    let original = f.svm.get_account(&f.state.pubkey()).unwrap();
    for i in 0..f.header.len() {
        let mut account = original.clone();
        account.data[i] ^= 1;
        f.svm.set_account(f.state.pubkey(), account).unwrap();
        f.reject(f.ix(false, 0), 4);
    }
    for len in [0, 1, f.size - 1, f.size + 1] {
        let mut account = original.clone();
        account.data.resize(len, 0);
        f.svm.set_account(f.state.pubkey(), account).unwrap();
        f.reject(f.ix(false, 0), 4);
    }
    for offset in [f.header.len(), f.header.len() + 1, f.header.len() + 38] {
        let mut account = original.clone();
        account.data[offset] = 255;
        f.svm.set_account(f.state.pubkey(), account).unwrap();
        f.reject(f.ix(false, 0), 4);
    }
    let mut wrong_owner = original.clone();
    wrong_owner.owner = Pubkey::new_unique();
    f.svm.set_account(f.state.pubkey(), wrong_owner).unwrap();
    f.reject(f.ix(false, 0), 3);
    f.svm.set_account(f.state.pubkey(), original).unwrap();
    let mut readonly = f.ix(false, 0);
    readonly.accounts[0].is_writable = false;
    f.reject(readonly, 5);
    let mut alias = f.ix(false, 0);
    alias.accounts[1] = AccountMeta::new_readonly(f.state.pubkey(), false);
    f.reject(alias, 6);
    for count in [0, 1, 3] {
        let mut ix = f.ix(false, 0);
        ix.accounts
            .resize(count, AccountMeta::new_readonly(f.attacker.pubkey(), false));
        f.reject(ix, 1);
    }
    for data in [
        vec![],
        vec![1],
        vec![1, 1, 0, 0, 0],
        vec![1, 1, 0, 0, 0, 0, 0],
        vec![2, 1, 0, 0, 0, 0],
        vec![1, 2, 0, 0, 0, 0],
    ] {
        let mut ix = f.ix(false, 0);
        ix.data = data;
        f.reject(ix, 2);
    }
}

#[test]
fn shared_storage_creation_and_failure_are_atomic() {
    let mut f = Storage::new();
    let mut unsigned = f.ix(true, 42);
    unsigned.accounts[1].is_signer = false;
    let err = f.send(&[f.create(), unsigned]).unwrap_err();
    assert_eq!(
        err.err,
        TransactionError::InstructionError(1, InstructionError::Custom(257))
    );
    assert!(f.svm.get_account(&f.state.pubkey()).is_none());
    f.send(&[f.create()]).unwrap();
    // An allocated but uninitialized account cannot be updated or initialized
    // without its address signing. The subsequent signed init still succeeds.
    f.reject(f.ix(false, 0), 4);
    let mut missing_state_signature = f.ix(true, 42);
    missing_state_signature.accounts[0].is_signer = false;
    f.reject(missing_state_signature, 7);
    f.send(&[f.ix(true, 42)]).unwrap();
}
