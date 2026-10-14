use litesvm::LiteSVM;
use serde_json::{json, Value};
use solana_instruction::{error::InstructionError, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use std::{env, fs, fs::OpenOptions, io::Write, path::PathBuf};

fn part(spec: &Value) -> Vec<u8> {
    match spec["kind"].as_str().expect("part kind") {
        "hex" => {
            let hex = spec["hex"].as_str().expect("hex part");
            assert_eq!(hex.len() % 2, 0);
            (0..hex.len())
                .step_by(2)
                .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
                .collect()
        }
        "repeat" => vec![
            spec["byte"].as_u64().expect("repeat byte") as u8;
            spec["length"].as_u64().expect("repeat length") as usize
        ],
        "ramp" => (0..spec["length"].as_u64().expect("ramp length"))
            .map(|index| (index & 0xff) as u8)
            .collect(),
        other => panic!("unknown test input generator: {other}"),
    }
}

fn encode(parts: &[Vec<u8>]) -> Vec<u8> {
    assert!(parts.len() <= u8::MAX as usize);
    let mut data = Vec::new();
    data.push(parts.len() as u8);
    for bytes in parts {
        assert!(bytes.len() <= u16::MAX as usize);
        data.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
        data.extend_from_slice(bytes);
    }
    data
}

fn execute(
    svm: &mut LiteSVM,
    payer: &Keypair,
    program: Pubkey,
    data: Vec<u8>,
) -> litesvm::types::TransactionResult {
    let instruction = Instruction {
        program_id: program,
        accounts: vec![],
        data,
    };
    let transaction = Transaction::new(
        &[payer],
        Message::new(&[instruction], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(transaction)
}

#[test]
fn bounded_sha256_syscall_matches_vectors_and_rejects_overlimits() {
    let elf = env::var("SHA256_TEST_ELF").expect("SHA256_TEST_ELF from tests/sha256.ts");
    let vectors_path = env::var("SHA256_VECTORS").expect("SHA256_VECTORS from tests/sha256.ts");
    let metrics_path = PathBuf::from(env::var("SHA256_METRICS").expect("SHA256_METRICS"));
    let cases: Vec<Value> = serde_json::from_slice(&fs::read(vectors_path).unwrap()).unwrap();
    assert_eq!(cases.len(), 15, "all required vector fixtures must execute");

    let mut svm = LiteSVM::new().with_transaction_history(0);
    let program = Pubkey::new_unique();
    svm.add_program_from_file(program, &elf).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    let mut total_cases = 0usize;
    let mut max_cu = 0u64;
    let mut observations = Vec::new();
    for case in &cases {
        let name = case["name"].as_str().expect("case name");
        let parts: Vec<Vec<u8>> = case["parts"]
            .as_array()
            .expect("parts")
            .iter()
            .map(part)
            .collect();
        let expected = case["expected"].as_str().expect("expected digest");
        let expected: Vec<u8> = (0..expected.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&expected[index..index + 2], 16).unwrap())
            .collect();
        assert_eq!(expected.len(), 32, "{name}");
        let data = encode(&parts);
        let preserved_data = data.clone();
        let result = execute(&mut svm, &payer, program, data.clone())
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert_eq!(result.return_data.program_id, program, "{name}");
        assert_eq!(result.return_data.data, expected, "digest byte order: {name}");
        assert_eq!(data, preserved_data, "host input fixture changed: {name}");
        max_cu = max_cu.max(result.compute_units_consumed);
        observations.push(json!({
            "name": name,
            "compute_units": result.compute_units_consumed,
            "input_bytes": parts.iter().map(Vec::len).sum::<usize>(),
            "slice_count": parts.len(),
        }));
        total_cases += 1;
    }

    let too_many_slices = vec![Vec::new(); 17];
    let failure = execute(&mut svm, &payer, program, encode(&too_many_slices))
        .expect_err("17 slices must reject");
    assert_eq!(failure.err, TransactionError::InstructionError(0, InstructionError::Custom(202)));
    let over_bytes = vec![vec![0x5a; 1024], vec![0xa5]];
    let failure = execute(&mut svm, &payer, program, encode(&over_bytes))
        .expect_err("1,025 bytes must reject");
    assert_eq!(failure.err, TransactionError::InstructionError(0, InstructionError::Custom(203)));
    total_cases += 2;

    let report = json!({
        "version": 1,
        "runtime": "LiteSVM 0.7.1",
        "cases": total_cases,
        "successful_vectors": cases.len(),
        "rejected_overlimits": ["17-slices", "1025-bytes"],
        "max_compute_units": max_cu,
        "observations": observations,
        "elf_bytes": fs::metadata(elf).unwrap().len(),
    });
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(metrics_path)
        .expect("write fresh metrics without replacing prior evidence");
    file.write_all(&serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    file.write_all(b"\n").unwrap();
}
