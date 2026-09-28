use litesvm::LiteSVM;
use serde::Deserialize;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

#[derive(Deserialize)]
struct ProbeCase {
    name: String,
    input: Vec<u8>,
    expected: Vec<u8>,
}

#[test]
fn arithmetic_probe_conformance_and_measurement() {
    let elf = std::env::var("ARITHMETIC_PROBE_ELF").expect("set ARITHMETIC_PROBE_ELF");
    let metrics = std::env::var("ARITHMETIC_PROBE_METRICS").expect("set ARITHMETIC_PROBE_METRICS");
    let cases: Vec<ProbeCase> = serde_json::from_slice(
        &std::fs::read("build/arithmetic-probe-vectors.json").expect("run benchmark builder first"),
    )
    .unwrap();
    assert_eq!(cases.len(), 14);

    let program = Pubkey::new_from_array([42; 32]);
    let payer = Keypair::new_from_array([7; 32]);
    let mut svm = LiteSVM::new().with_transaction_history(0);
    svm.add_program_from_file(program, &elf).unwrap();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    let mut rows = Vec::with_capacity(cases.len());
    for case in cases {
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
            .unwrap_or_else(|error| panic!("{} unexpectedly failed: {:?}", case.name, error));
        assert_eq!(meta.return_data.program_id, program, "{}", case.name);
        assert_eq!(meta.return_data.data, case.expected, "{}", case.name);
        rows.push(serde_json::json!({
            "name": case.name,
            "inputHex": case.input.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
            "returnDataHex": meta.return_data.data.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
            "outerSuccess": true,
            "computeUnits": meta.compute_units_consumed,
        }));
    }

    std::fs::write(&metrics, serde_json::to_vec_pretty(&rows).unwrap()).unwrap();
    println!(
        "{} arithmetic probe fixtures passed under LiteSVM",
        rows.len()
    );
}
