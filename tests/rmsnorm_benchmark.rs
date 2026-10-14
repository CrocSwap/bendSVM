use litesvm::LiteSVM;
use serde::Deserialize;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::str::FromStr;

#[derive(Deserialize)]
struct Case { name: String, input: Vec<u8>, expected: Vec<u8> }

#[test]
fn rmsnorm_conformance_and_measurement() {
    let elf = std::env::var("RMSNORM_ELF").expect("set RMSNORM_ELF");
    let metrics = std::env::var("RMSNORM_METRICS").expect("set RMSNORM_METRICS");
    let prefixes = std::env::var("RMSNORM_PREFIX_CASES").as_deref() == Ok("1");
    let vectors = if prefixes { "build/rmsnorm-prefix-vectors.json" } else { "build/rmsnorm-vectors.json" };
    let cases: Vec<Case> = serde_json::from_slice(&std::fs::read(vectors).unwrap()).unwrap();
    assert_eq!(cases.len(), if prefixes { 195 } else { 18 });
    let program = Pubkey::new_from_array([53;32]);
    let payer = Keypair::new_from_array([7;32]);
    let mut svm = LiteSVM::new().with_transaction_history(0);
    svm.add_program_from_file(program,&elf).unwrap();
    svm.airdrop(&payer.pubkey(),1_000_000_000).unwrap();
    let mut rows = Vec::new();
    for case in cases {
        let ix = Instruction { program_id:program, accounts:vec![], data:case.input };
        // ComputeBudgetInstruction::SetComputeUnitLimit (Solana 2.2 wire tag 2).
        let mut limit = vec![2u8];
        limit.extend_from_slice(&1_400_000u32.to_le_bytes());
        let budget = Instruction { program_id:Pubkey::from_str("ComputeBudget111111111111111111111111111111").unwrap(),
            accounts:vec![], data:limit };
        let tx = Transaction::new(&[&payer],Message::new(&[budget,ix],Some(&payer.pubkey())),svm.latest_blockhash());
        let meta = svm.send_transaction(tx).unwrap_or_else(|e| panic!("{} failed: {e:?}",case.name));
        assert_eq!(meta.return_data.program_id,program,"{}",case.name);
        assert_eq!(meta.return_data.data,case.expected,"{}",case.name);
        rows.push(serde_json::json!({"name":case.name,"computeUnits":meta.compute_units_consumed}));
    }
    std::fs::write(metrics,serde_json::to_vec_pretty(&rows).unwrap()).unwrap();
    println!("{} RMSNorm cases passed",rows.len());
}
