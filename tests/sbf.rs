#[path = "amm_sbf.rs"]
mod amm_sbf;
use litesvm::{types::TransactionResult, LiteSVM};
use serde::Deserialize;
use solana_account::Account;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

#[path = "amm_rust_math.rs"]
mod amm_rust_math;
#[path = "token_issuance_sbf.rs"]
mod token_issuance_sbf;
#[path = "token_three_sbf.rs"]
mod token_three_sbf;

#[path = "cpi_sbf.rs"]
mod cpi_sbf;
#[path = "multi_storage_sbf.rs"]
mod multi_storage_sbf;
#[path = "storage_sbf.rs"]
mod storage_sbf;
#[path = "vault_sbf.rs"]
mod vault_sbf;

#[test]
fn generated_codec_dispatcher_runs_in_sbf() {
    #[derive(Deserialize)]
    struct Case {
        name: String,
        input: Vec<u8>,
        expected: Option<Vec<u8>>,
    }
    let cases: Vec<Case> = serde_json::from_slice(
        &std::fs::read("build/codecs-vectors.json").expect("run npm test first"),
    )
    .unwrap();
    assert!(cases.len() > 200);
    let mut svm = LiteSVM::new().with_transaction_history(0);
    let program = Pubkey::new_unique();
    svm.add_program_from_file(program, "build/codecs.so")
        .unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let mut max_cu = 0;
    for case in &cases {
        let ix = Instruction {
            program_id: program,
            accounts: vec![],
            data: case.input.clone(),
        };
        let tx = Transaction::new(
            &[&payer],
            Message::new(&[ix], Some(&payer.pubkey())),
            svm.latest_blockhash(),
        );
        match (&case.expected, svm.send_transaction(tx)) {
            (Some(expected), Ok(meta)) => {
                assert_eq!(meta.return_data.program_id, program);
                assert_eq!(&meta.return_data.data, expected, "{}", case.name);
                max_cu = max_cu.max(meta.compute_units_consumed);
            }
            (None, Err(error)) => assert_eq!(
                error.err,
                TransactionError::InstructionError(0, InstructionError::Custom(2)),
                "{}",
                case.name
            ),
            (_, result) => panic!("{}: unexpected {:?}", case.name, result),
        }
    }
    println!(
        "{} generated interface SBF cases passed; max {max_cu} CU",
        cases.len()
    );
    std::fs::write(
        "build/codecs-metrics.json",
        serde_json::to_vec_pretty(&serde_json::json!({
            "cases": cases.len(), "max_cu": max_cu,
            "elf_bytes": std::fs::metadata("build/codecs.so").unwrap().len()
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn arithmetic_reference_native_and_sbf_agree() {
    #[derive(Deserialize)]
    struct Case {
        name: String,
        input: Vec<u8>,
        expected: Vec<u8>,
    }
    let cases: Vec<Case> = serde_json::from_slice(
        &std::fs::read("build/arithmetic-vectors.json").expect("run npm test first"),
    )
    .unwrap();
    assert!(cases.len() > 1000);
    let mut svm = LiteSVM::new().with_transaction_history(0);
    let program = Pubkey::new_unique();
    svm.add_program_from_file(program, "build/arithmetic.so")
        .unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let mut max_cu = 0;
    for case in &cases {
        let ix = Instruction {
            program_id: program,
            accounts: vec![],
            data: case.input.clone(),
        };
        let tx = Transaction::new(
            &[&payer],
            Message::new(&[ix], Some(&payer.pubkey())),
            svm.latest_blockhash(),
        );
        let result = svm
            .send_transaction(tx)
            .unwrap_or_else(|e| panic!("{}: {:?}", case.name, e));
        assert_eq!(result.return_data.program_id, program);
        assert_eq!(result.return_data.data, case.expected, "{}", case.name);
        max_cu = max_cu.max(result.compute_units_consumed);
    }
    println!(
        "{} arithmetic SBF cases passed; max {max_cu} CU",
        cases.len()
    );
    std::fs::write(
        "build/arithmetic-metrics.json",
        serde_json::to_vec_pretty(&serde_json::json!({
            "cases": cases.len(), "max_cu": max_cu,
            "elf_bytes": std::fs::metadata("build/arithmetic.so").unwrap().len()
        }))
        .unwrap(),
    )
    .unwrap();
}

struct Fixture {
    svm: LiteSVM,
    program: Pubkey,
    state: Pubkey,
    payer: Keypair,
    authority: Keypair,
    attacker: Keypair,
}

impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new().with_transaction_history(0);
        let program = Pubkey::new_unique();
        svm.add_program_from_file(program, "build/escrow.so")
            .unwrap();
        let payer = Keypair::new();
        let authority = Keypair::new();
        let attacker = Keypair::new();
        for key in [&payer, &authority, &attacker] {
            svm.airdrop(&key.pubkey(), 1_000_000_000).unwrap();
        }
        Self {
            svm,
            program,
            state: Pubkey::new_unique(),
            payer,
            authority,
            attacker,
        }
    }
    fn reset(&mut self, tag: u8, lo: u32, hi: u32) {
        let mut data = vec![0; 48];
        data[..4].copy_from_slice(b"BND2");
        data[4] = 1;
        data[5] = tag;
        data[8..12].copy_from_slice(&lo.to_le_bytes());
        data[12..16].copy_from_slice(&hi.to_le_bytes());
        data[16..].copy_from_slice(self.authority.pubkey().as_ref());
        self.svm
            .set_account(
                self.state,
                Account {
                    lamports: 10_000_000,
                    data,
                    owner: self.program,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }
    fn instruction(&self, signer: bool, writable: bool, attacker: bool) -> Instruction {
        Instruction {
            program_id: self.program,
            accounts: vec![
                if writable {
                    AccountMeta::new(self.state, false)
                } else {
                    AccountMeta::new_readonly(self.state, false)
                },
                AccountMeta::new_readonly(
                    if attacker {
                        self.attacker.pubkey()
                    } else {
                        self.authority.pubkey()
                    },
                    signer,
                ),
            ],
            data: vec![0],
        }
    }
    fn send(&mut self, instruction: Instruction) -> TransactionResult {
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        for meta in &instruction.accounts {
            if meta.is_signer && meta.pubkey == self.authority.pubkey() {
                signers.push(&self.authority);
            }
            if meta.is_signer && meta.pubkey == self.attacker.pubkey() {
                signers.push(&self.attacker);
            }
        }
        let tx = Transaction::new(
            &signers,
            Message::new(&[instruction], Some(&self.payer.pubkey())),
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx)
    }
    fn reject(&mut self, instruction: Instruction, code: u32) {
        let before = self.svm.get_account(&self.state).unwrap();
        let err = self.send(instruction).unwrap_err();
        assert_eq!(
            err.err,
            TransactionError::InstructionError(0, InstructionError::Custom(code)),
            "logs: {:?}",
            err.meta.logs
        );
        assert_eq!(
            self.svm.get_account(&self.state).unwrap(),
            before,
            "failed transaction changed state"
        );
    }
}

#[derive(Deserialize)]
struct Vector {
    authorized: bool,
    tag: u8,
    lo: u32,
    hi: u32,
    expected_tag: u8,
    expected_lo: u32,
    expected_hi: u32,
}

#[test]
fn bend_reference_native_and_sbf_agree() {
    let vectors: Vec<Vector> = serde_json::from_slice(
        &std::fs::read("build/vectors.json")
            .expect("run npm test to generate the Bend reference vectors first"),
    )
    .unwrap();
    assert!(vectors.len() >= 100);
    let mut f = Fixture::new();
    let mut min_cu = u64::MAX;
    let mut max_cu = 0;
    for v in &vectors {
        f.reset(v.tag, v.lo, v.hi);
        let before = f.svm.get_account(&f.state).unwrap();
        let ix = f.instruction(v.authorized, true, false);
        if v.authorized {
            let meta = f.send(ix).unwrap();
            let after = f.svm.get_account(&f.state).unwrap();
            let mut expected = before.clone();
            expected.data[5] = v.expected_tag;
            expected.data[8..12].copy_from_slice(&v.expected_lo.to_le_bytes());
            expected.data[12..16].copy_from_slice(&v.expected_hi.to_le_bytes());
            assert_eq!(after, expected); // Includes amount, authority, metadata and lamports.
            let mut reply = vec![v.expected_tag];
            reply.extend(v.expected_lo.to_le_bytes());
            reply.extend(v.expected_hi.to_le_bytes());
            assert_eq!(meta.return_data.program_id, f.program);
            assert_eq!(meta.return_data.data, reply);
            min_cu = min_cu.min(meta.compute_units_consumed);
            max_cu = max_cu.max(meta.compute_units_consumed);
            assert!(meta.compute_units_consumed < 10_000);
        } else {
            assert_eq!(
                (v.expected_tag, v.expected_lo, v.expected_hi),
                (v.tag, v.lo, v.hi)
            );
            f.reject(ix, 7);
        }
    }
    println!(
        "{} Bend/native/SBF differential cases; successful release CU: {min_cu}..{max_cu}",
        vectors.len()
    );
    std::fs::write(
        "build/metrics.json",
        serde_json::to_vec_pretty(&serde_json::json!({
            "vectors": vectors.len(), "min_success_cu": min_cu, "max_success_cu": max_cu,
            "elf_bytes": std::fs::metadata("build/escrow.so").unwrap().len(),
            "runtime": "LiteSVM 0.7.1", "sbpf_version": 0
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn authorization_validation_and_transaction_atomicity() {
    let mut f = Fixture::new();
    f.reset(0, u32::MAX, u32::MAX);
    f.reject(f.instruction(false, true, false), 7);
    f.reject(f.instruction(true, true, true), 7);
    f.reject(f.instruction(true, false, false), 5);
    let original = f.svm.get_account(&f.state).unwrap();
    let mut wrong_owner = original.clone();
    wrong_owner.owner = Pubkey::new_unique();
    f.svm.set_account(f.state, wrong_owner).unwrap();
    f.reject(f.instruction(true, true, false), 3);
    f.svm.set_account(f.state, original.clone()).unwrap();
    for (offset, value) in [(0, 0), (4, 2), (5, 2), (6, 1), (7, 1)] {
        let mut malformed = original.clone();
        malformed.data[offset] = value;
        f.svm.set_account(f.state, malformed).unwrap();
        f.reject(f.instruction(true, true, false), 4);
    }
    for len in [0, 1, 47, 49] {
        let mut malformed = original.clone();
        malformed.data.resize(len, 0);
        f.svm.set_account(f.state, malformed).unwrap();
        f.reject(f.instruction(true, true, false), 4);
    }
    f.svm.set_account(f.state, original).unwrap();
    for data in [vec![], vec![1], vec![0, 0]] {
        let mut ix = f.instruction(true, true, false);
        ix.data = data;
        f.reject(ix, 2);
    }
    let mut missing = f.instruction(true, true, false);
    missing.accounts.pop();
    f.reject(missing, 1);
    let mut extra = f.instruction(true, true, false);
    extra
        .accounts
        .push(AccountMeta::new_readonly(f.attacker.pubkey(), false));
    f.reject(extra, 1);
    let mut duplicate = f.instruction(false, true, false);
    duplicate.accounts[1] = AccountMeta::new_readonly(f.state, false);
    f.reject(duplicate, 6);
    f.send(f.instruction(true, true, false)).unwrap();
    let released = f.svm.get_account(&f.state).unwrap();
    f.send(f.instruction(true, true, false)).unwrap();
    assert_eq!(
        f.svm.get_account(&f.state).unwrap(),
        released,
        "release must be idempotent"
    );
}

#[path = "exchange_sbf.rs"]
mod exchange_sbf;
#[path = "token_fixture.rs"]
mod token_fixture;
#[path = "validation.rs"]
mod validation;
#[path = "vesting_sbf.rs"]
mod vesting_sbf;

#[test]
fn wide_and_entitlement_oracles_execute_in_sbf() {
    run_oracles(&["wide", "entitlement", "pricing"], 61);
}

#[test]
fn amm_math_oracles_execute_in_sbf() {
    run_oracles(&["amm-pricing", "sqrt"], 61);
}

#[test]
fn generic_specializations_execute_in_sbf() {
    run_oracles(&["generics"], 37);
}

#[test]
fn bounded_buffers_execute_in_sbf() {
    run_oracles(&["buffer"], 181);
}

#[test]
fn bounded_iteration_executes_in_sbf() {
    run_oracles(&["iteration"], 325);
}

#[test]
fn bounded_iteration_rejects_excessive_fuel() {
    let mut svm = LiteSVM::new().with_transaction_history(0);
    let program = Pubkey::new_unique();
    svm.add_program_from_file(program, "build/iteration.so").unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    for fuel in [65u32, u32::MAX] {
        let mut data = vec![0u8];
        data.extend_from_slice(&fuel.to_le_bytes());
        data.extend_from_slice(&17u32.to_le_bytes());
        let ix = Instruction { program_id: program, accounts: vec![], data };
        let tx = Transaction::new(&[&payer], Message::new(&[ix], Some(&payer.pubkey())), svm.latest_blockhash());
        assert!(svm.send_transaction(tx).is_err(), "fuel {fuel} must be rejected");
    }
}

#[test]
fn bounded_folds_execute_in_sbf() {
    run_oracles(&["fold"], 1092);
}

#[test]
fn batch_pure_oracles_execute_in_sbf() {
    run_oracles(&["batch-pure"], 120);
}

#[test]
fn collection_windows_execute_in_sbf() {
    run_oracles(&["collection"], 860);
}

fn run_oracles(stems: &[&str], minimum_cases: usize) {
    for stem in stems {
        #[derive(Deserialize)]
        struct Case {
            name: String,
            input: Vec<u8>,
            expected: Vec<u8>,
        }
        let cases: Vec<Case> =
            serde_json::from_slice(&std::fs::read(format!("build/{stem}-vectors.json")).unwrap())
                .unwrap();
        assert!(cases.len() >= minimum_cases);
        let mut svm = LiteSVM::new().with_transaction_history(0);
        let program = Pubkey::new_unique();
        svm.add_program_from_file(program, format!("build/{stem}.so"))
            .unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
        let mut max_cu = 0;
        for case in &cases {
            let ix = Instruction {
                program_id: program,
                accounts: vec![],
                data: case.input.clone(),
            };
            let tx = Transaction::new(
                &[&payer],
                Message::new(&[ix], Some(&payer.pubkey())),
                svm.latest_blockhash(),
            );
            let meta = svm
                .send_transaction(tx)
                .unwrap_or_else(|e| panic!("{}: {:?}", case.name, e));
            assert_eq!(meta.return_data.program_id, program);
            assert_eq!(meta.return_data.data, case.expected, "{}", case.name);
            max_cu = max_cu.max(meta.compute_units_consumed);
        }
        println!(
            "{stem}: {} SBF oracle cases passed; max {max_cu} CU",
            cases.len()
        );
        std::fs::write(format!("build/{stem}-metrics.json"),serde_json::to_vec_pretty(&serde_json::json!({
            "cases":cases.len(),"max_cu":max_cu,"elf_bytes":std::fs::metadata(format!("build/{stem}.so")).unwrap().len()
        })).unwrap()).unwrap();
    }
}

#[path = "batch_sbf.rs"]
mod batch_sbf;

#[path = "collection_store_sbf.rs"]
mod collection_store_sbf;

#[path = "queue_sbf.rs"]
mod queue_sbf;

#[path = "collection_cpi_sbf.rs"]
mod collection_cpi_sbf;
