use super::*;

// ABI 1 state-frame evidence on the pinned LiteSVM runtime. The adapter is the
// unchanged tests/cpi.bend executor probe; tests/cpi-frame-callee.c records the
// forwarded account as the runtime exposes it. Build with tests/cpi-frame.ts.
struct Frame {
    svm: LiteSVM,
    caller: Pubkey,
    callee: Pubkey,
    payer: Keypair,
    actor: Keypair,
    state: Keypair,
    custody: Pubkey,
    record: Pubkey,
    foreign: Pubkey,
    header: Vec<u8>,
    instruction_bytes: usize,
}

type Meta = (u32, Pubkey, bool, bool);

impl Frame {
    fn new() -> Self {
        let layout: serde_json::Value = serde_json::from_slice(
            &std::fs::read("build/cpi-frame.interface.json").expect("run tests/cpi-frame.ts first"),
        )
        .unwrap();
        assert_eq!(layout["version"], 1);
        assert_eq!(layout["effects"], "cpi-v1");
        let header: Vec<u8> = serde_json::from_value(layout["header"].clone()).unwrap();
        let state_bytes = layout["stateBytes"].as_u64().unwrap() as usize;
        assert_eq!((header.len(), state_bytes), (20, 25));
        let mut svm = crate::test_svm().with_transaction_history(0);
        let caller = Pubkey::new_unique();
        let callee = Pubkey::new_unique();
        svm.add_program_from_file(caller, "build/cpi-frame.so")
            .unwrap();
        svm.add_program_from_file(callee, "build/cpi-frame-callee.so")
            .unwrap();
        let payer = Keypair::new();
        let actor = Keypair::new();
        let state = Keypair::new();
        let record = Pubkey::new_unique();
        let foreign = Pubkey::new_unique();
        let custody = Pubkey::find_program_address(&[b"bend", state.pubkey().as_ref()], &caller).0;
        for key in [payer.pubkey(), actor.pubkey(), custody] {
            svm.airdrop(&key, 1_000_000_000).unwrap();
        }
        // The foreign account is writable in the transaction but owned by neither
        // program: the control for the runtime's owner check.
        for (key, owner, size, fill) in [
            (state.pubkey(), caller, state_bytes, 0),
            (record, callee, 44 + state_bytes, 0),
            (foreign, Pubkey::new_unique(), state_bytes, 7),
        ] {
            svm.set_account(
                key,
                Account {
                    lamports: 1_000_000,
                    data: vec![fill; size],
                    owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        }
        Frame {
            svm,
            caller,
            callee,
            payer,
            actor,
            state,
            custody,
            record,
            foreign,
            header,
            instruction_bytes: layout["instructionBytes"].as_u64().unwrap() as usize,
        }
    }

    fn record_meta(&self) -> Meta {
        (4, self.record, true, false)
    }

    fn state_meta(&self, writable: bool, signer: bool) -> Meta {
        (0, self.state.pubkey(), writable, signer)
    }

    // Canonical Run{Invoke}: one payload byte selects the callee mode.
    fn ix(&self, initialize: bool, mode: u8, metas: &[Meta]) -> Instruction {
        let mut data = vec![if initialize { 0 } else { 1 }, 0, 1];
        data.extend(2u32.to_le_bytes());
        data.push(0);
        data.extend(self.callee.to_bytes());
        data.extend(1u32.to_le_bytes());
        data.push(0);
        data.push(mode);
        data.resize(data.len() + 63, 0);
        data.extend((metas.len() as u32).to_le_bytes());
        data.push(0);
        for i in 0..8 {
            let (index, key, writable, signer) =
                metas
                    .get(i)
                    .copied()
                    .unwrap_or((0, Pubkey::default(), false, false));
            data.push(0);
            data.extend(index.to_le_bytes());
            data.push(0);
            data.extend(key.to_bytes());
            data.push(u8::from(writable));
            data.push(u8::from(signer));
        }
        assert_eq!(data.len(), self.instruction_bytes);
        Instruction {
            program_id: self.caller,
            accounts: vec![
                AccountMeta::new(self.state.pubkey(), initialize),
                AccountMeta::new_readonly(self.actor.pubkey(), true),
                AccountMeta::new_readonly(self.callee, false),
                AccountMeta::new_readonly(self.custody, false),
                AccountMeta::new(self.record, false),
                AccountMeta::new(self.foreign, false),
            ],
            data,
        }
    }

    fn send(&mut self, instruction: Instruction) -> TransactionResult {
        let mut signers = vec![&self.payer, &self.actor];
        if instruction.accounts[0].is_signer {
            signers.push(&self.state);
        }
        let transaction = Transaction::new(
            &signers,
            Message::new(&[instruction], Some(&self.payer.pubkey())),
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(transaction)
    }

    // Every account the instruction names except the fee payer.
    fn snapshot(&self) -> Vec<Option<Account>> {
        [
            self.state.pubkey(),
            self.actor.pubkey(),
            self.custody,
            self.record,
            self.foreign,
        ]
        .iter()
        .map(|key| self.svm.get_account(key))
        .collect()
    }

    fn data(&self, key: Pubkey) -> Vec<u8> {
        self.svm.get_account(&key).unwrap().data
    }

    fn expected_state(&self, count: u32) -> Vec<u8> {
        let mut bytes = self.header.clone();
        bytes.push(0);
        bytes.extend(count.to_le_bytes());
        bytes
    }

    // Callee record: receipt counter, then the observed account's writable,
    // signer and executable flags, size, owner and data.
    fn expected_record(&self, receipts: u8, signer: bool, observed: &[u8]) -> Vec<u8> {
        let mut bytes = vec![receipts, 0, u8::from(signer), 0];
        bytes.extend((observed.len() as u64).to_le_bytes());
        bytes.extend(self.caller.to_bytes());
        bytes.extend(observed);
        bytes
    }

    fn invoked(&self, logs: &[String]) -> bool {
        let prefix = format!("Program {} invoke", self.callee);
        logs.iter().any(|l| l.starts_with(&prefix))
    }

    fn succeeded(&self, logs: &[String]) -> bool {
        logs.contains(&format!("Program {} success", self.callee))
    }
}

fn custom(code: u32) -> TransactionError {
    TransactionError::InstructionError(0, InstructionError::Custom(code))
}

#[test]
fn cpi_frame_readonly_state_forward_exposes_pre_transition_state() {
    let mut f = Frame::new();
    let zero = vec![0; 25];
    // The state keypair signs the initialization, but its signature reaches the
    // callee only when the meta requests it.
    let before = f.snapshot();
    let metas = [f.record_meta(), f.state_meta(false, false)];
    let error = f.send(f.ix(true, 1, &metas)).unwrap_err();
    assert_eq!(error.err, custom(5));
    assert!(f.invoked(&error.meta.logs) && !f.succeeded(&error.meta.logs));
    assert_eq!(f.snapshot(), before);

    let metas = [f.record_meta(), f.state_meta(false, true)];
    let meta = f.send(f.ix(true, 1, &metas)).unwrap();
    assert!(f.succeeded(&meta.logs));
    assert_eq!(f.data(f.record), f.expected_record(1, true, &zero));
    assert_eq!(f.data(f.state.pubkey()), f.expected_state(1));
    assert_eq!(meta.return_data.data, f.expected_state(1)[20..]);

    // A transition forwards the committed header and old payload, not the
    // encoded next state; the commit still happens after the call.
    let old = f.expected_state(1);
    let metas = [f.record_meta(), f.state_meta(false, false)];
    let meta = f.send(f.ix(false, 0, &metas)).unwrap();
    assert!(f.succeeded(&meta.logs));
    assert_eq!(f.data(f.record), f.expected_record(2, false, &old));
    assert_eq!(f.data(f.state.pubkey()), f.expected_state(2));
    assert_ne!(old, f.expected_state(2));

    // Outside initialization the state address does not sign, so the adapter
    // refuses to request its signature before calling anything.
    let before = f.snapshot();
    let metas = [f.record_meta(), f.state_meta(false, true)];
    let error = f.send(f.ix(false, 1, &metas)).unwrap_err();
    assert_eq!(error.err, custom(21));
    assert!(!f.invoked(&error.meta.logs));
    assert_eq!(f.snapshot(), before);
    println!(
        "CPI frame: read-only state forward saw pre-transition bytes, signer only on request; {} CU",
        meta.compute_units_consumed
    );
}

#[test]
fn cpi_frame_callee_write_to_readonly_state_aborts_and_rolls_back() {
    let mut f = Frame::new();
    let metas = [f.record_meta(), f.state_meta(false, false)];
    f.send(f.ix(true, 0, &metas)).unwrap();
    f.send(f.ix(false, 0, &metas)).unwrap();
    let before = f.snapshot();
    assert_eq!(f.data(f.record)[0], 2);

    // Mode 2 writes the callee's own receipt, then the forwarded state. State is
    // both read-only in the CPI and owned by the adapter; the runtime reports
    // the read-only violation.
    let error = f.send(f.ix(false, 2, &metas)).unwrap_err();
    assert_eq!(
        error.err,
        TransactionError::InstructionError(0, InstructionError::ReadonlyDataModified)
    );
    assert!(f.invoked(&error.meta.logs) && !f.succeeded(&error.meta.logs));
    assert_eq!(f.snapshot(), before, "read-only state write escaped");
    let readonly_logs = error.meta.logs;

    // Control: the same write to a writable account the callee does not own
    // yields the distinct foreign-owner error.
    let metas = [f.record_meta(), (5, f.foreign, true, false)];
    let error = f.send(f.ix(false, 2, &metas)).unwrap_err();
    assert_eq!(
        error.err,
        TransactionError::InstructionError(0, InstructionError::ExternalAccountDataModified)
    );
    assert!(f.invoked(&error.meta.logs) && !f.succeeded(&error.meta.logs));
    assert_eq!(f.snapshot(), before, "foreign account write escaped");

    // Both failures left the adapter usable from the unchanged state.
    let metas = [f.record_meta(), f.state_meta(false, false)];
    f.send(f.ix(false, 0, &metas)).unwrap();
    assert_eq!(f.data(f.record)[0], 3);
    assert_eq!(f.data(f.state.pubkey()), f.expected_state(3));
    println!("CPI frame: callee state write aborted with rollback: {readonly_logs:?}");
}

#[test]
fn cpi_frame_writable_state_meta_is_rejected_before_callee() {
    let mut f = Frame::new();
    // Initialization: state is writable and signing, yet may not be forwarded writable.
    for signer in [false, true] {
        let before = f.snapshot();
        let metas = [f.record_meta(), f.state_meta(true, signer)];
        let error = f.send(f.ix(true, 0, &metas)).unwrap_err();
        assert_eq!(error.err, custom(22));
        assert!(!f.invoked(&error.meta.logs));
        assert_eq!(f.snapshot(), before);
    }
    assert_eq!(f.data(f.state.pubkey()), vec![0; 25]);
    let metas = [f.record_meta(), f.state_meta(false, false)];
    f.send(f.ix(true, 0, &metas)).unwrap();
    // Transition, with the state meta in either position.
    for metas in [
        vec![f.record_meta(), f.state_meta(true, false)],
        vec![f.state_meta(true, false), f.record_meta()],
        vec![f.state_meta(true, false)],
    ] {
        let before = f.snapshot();
        let error = f.send(f.ix(false, 2, &metas)).unwrap_err();
        assert_eq!(error.err, custom(22));
        assert!(!f.invoked(&error.meta.logs));
        assert_eq!(f.snapshot(), before);
    }
    assert_eq!(f.data(f.record)[0], 1);
    assert_eq!(f.data(f.state.pubkey()), f.expected_state(1));
    println!("CPI frame: writable managed-state meta rejected with error 22 before the callee");
}
