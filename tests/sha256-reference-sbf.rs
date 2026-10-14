use litesvm::LiteSVM;
use serde_json::{json, Value};
use solana_instruction::error::InstructionError;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;

const EXPECTED_CASES: [&str; 13] = [
    "empty",
    "abc",
    "padding-55",
    "random-short-1",
    "random-short-17",
    "random-short-31",
    "random-short-54",
    "inactive-all-ones",
    "inactive-mixed",
    "length-56",
    "length-u32-max",
    "active-byte-256-at-start",
    "active-byte-256-at-end",
];

fn bytes(value: &Value) -> Vec<u8> {
    value
        .as_array()
        .expect("byte array")
        .iter()
        .map(|item| u8::try_from(item.as_u64().expect("unsigned byte")).expect("u8 byte"))
        .collect()
}

fn hex(data: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(data.len() * 2);
    for byte in data {
        encoded.push(DIGITS[(byte >> 4) as usize] as char);
        encoded.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    program_id: Pubkey,
    instruction_data: Vec<u8>,
    account_count: usize,
) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    let mut budget = vec![2u8];
    budget.extend_from_slice(&1_400_000u32.to_le_bytes());
    let limit = Instruction {
        program_id: Pubkey::from_str("ComputeBudget111111111111111111111111111111")
            .expect("compute budget program ID"),
        accounts: vec![],
        data: budget,
    };
    let instruction = Instruction {
        program_id,
        accounts: match account_count {
            0 => vec![],
            1 => vec![AccountMeta::new_readonly(payer.pubkey(), false)],
            _ => panic!("unsupported adapter account-count probe {account_count}"),
        },
        data: instruction_data,
    };
    let transaction = Transaction::new(
        &[payer],
        Message::new(&[limit, instruction], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(transaction)
}

#[test]
fn checked_bend_sha_reference_executes_through_zero_account_solana_adapter() {
    let run_dir = PathBuf::from(
        std::env::var("SHA256_REFERENCE_RUN_DIR").expect("fresh gate run directory"),
    );
    let cases: Value = serde_json::from_slice(
        &fs::read(run_dir.join("execution-cases.json")).expect("fresh generated SBF cases"),
    )
    .expect("valid generated SBF case JSON");
    assert_eq!(cases["schemaVersion"], 1);
    let cases = cases["cases"].as_array().expect("case array");
    assert_eq!(cases.len(), EXPECTED_CASES.len(), "all 13 source cases");
    for (case, expected_name) in cases.iter().zip(EXPECTED_CASES) {
        assert_eq!(case["name"], expected_name, "fresh source case order");
    }

    let elf = run_dir.join("sha256-reference-sbf.so");
    let program_id = Pubkey::new_from_array([0x53; 32]);
    let payer = Keypair::new();
    let mut svm = LiteSVM::new().with_transaction_history(0);
    svm.add_program_from_file(program_id, &elf)
        .unwrap_or_else(|error| panic!("load freshly compiled SBF ELF: {error:?}"));
    svm.airdrop(&payer.pubkey(), 1_000_000_000)
        .expect("fund ephemeral test payer in LiteSVM");

    let mut observations = Vec::with_capacity(cases.len());
    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let instruction_data = bytes(&case["instructionData"]);
        let expected = bytes(&case["expectedReturnData"]);
        let result = send(&mut svm, &payer, program_id, instruction_data, 0)
            .unwrap_or_else(|error| panic!("{name}: expected successful SBF execution, got {error:?}"));
        assert_eq!(
            result.return_data.program_id, program_id,
            "return-data program ID for {name}"
        );
        assert_eq!(
            result.return_data.data, expected,
            "canonical return bytes for {name}"
        );
        let observed = json!({
            "name": name,
            "status": "success",
            "programId": result.return_data.program_id.to_string(),
            "disposition": case["expectedDisposition"],
            "returnDataHex": hex(&result.return_data.data),
            "computeUnits": result.compute_units_consumed,
        });
        println!("LiteSVM SHA reference {name}: success, {} CU", result.compute_units_consumed);
        observations.push(observed);
    }

    let failures = cases_for_adapter_failures(&cases, &run_dir);
    let mut adapter_failures = Vec::with_capacity(failures.len());
    for failure in failures {
        let name = failure["name"].as_str().expect("adapter failure name");
        let expected = failure["expectedError"]
            .as_str()
            .expect("adapter failure expectation");
        let account_count = usize::try_from(failure["accountCount"].as_u64().unwrap_or(0))
            .expect("adapter account count fits usize");
        let error = send(
            &mut svm,
            &payer,
            program_id,
            bytes(&failure["input"]),
            account_count,
        )
        .expect_err("malformed adapter input must fail the transaction");
        let expected_error = match name {
            "account-count-nonzero" => {
                TransactionError::InstructionError(1, InstructionError::Custom(1))
            }
            "instruction-over-1024" => {
                TransactionError::InstructionError(1, InstructionError::Custom(2))
            }
            "malformed-wire-empty" => {
                TransactionError::InstructionError(1, InstructionError::Custom(3))
            }
            _ => panic!("unexpected adapter failure case {name}"),
        };
        assert_eq!(
            error.err,
            expected_error,
            "explicit adapter error for {name}"
        );
        let observed_error = format!("{:?}", error.err);
        assert_eq!(observed_error, expected, "recorded adapter error for {name}");
        println!("LiteSVM SHA reference {name}: error {observed_error}");
        adapter_failures.push(json!({
            "name": name,
            "status": "error",
            "error": observed_error,
        }));
    }

    let report = json!({
        "passed": true,
        "scope": "fresh checked-Bend single-block SHA reference cases executed in LiteSVM through a test-only zero-account Solana instruction adapter",
        "programId": program_id.to_string(),
        "computeUnitLimit": 1_400_000,
        "observations": observations,
        "adapterFailures": adapter_failures,
    });
    let report_path = run_dir.join("execution.json");
    fs::write(
        &report_path,
        serde_json::to_vec_pretty(&report).expect("serialize execution evidence"),
    )
    .expect("write fresh execution evidence");
}

fn cases_for_adapter_failures(cases: &[Value], run_dir: &PathBuf) -> Vec<Value> {
    // The case generator owns the malformed adapter inputs too. Read the same
    // per-run file again so the Rust child never uses stale checked-in vectors.
    let full: Value = serde_json::from_slice(
        &fs::read(run_dir.join("execution-cases.json")).expect("generated adapter failures"),
    )
    .expect("valid generated adapter failure JSON");
    assert_eq!(full["cases"].as_array().unwrap().len(), cases.len());
    let failures = full["adapterFailures"]
        .as_array()
        .expect("adapter failure array");
    assert_eq!(failures.len(), 3, "account-count, length, and wire probes");
    failures.clone()
}
