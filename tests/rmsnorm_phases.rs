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
fn rmsnorm_phase_diagnostic() {
    let elf = std::env::var("RMSNORM_ELF").expect("set RMSNORM_ELF");
    let metrics = std::env::var("RMSNORM_METRICS").expect("set RMSNORM_METRICS");
    let cases: Vec<Case> = serde_json::from_slice(&std::fs::read("build/rmsnorm-vectors.json").unwrap()).unwrap();
    let program = Pubkey::new_from_array([53;32]);
    let payer = Keypair::new_from_array([7;32]);
    let mut svm = LiteSVM::new().with_transaction_history(0);
    svm.add_program_from_file(program,&elf).unwrap();
    svm.airdrop(&payer.pubkey(),1_000_000_000).unwrap();
    let mut rows = Vec::new();
    for case in cases.into_iter().filter(|c| ["mixed_8", "mixed_16", "mixed_32", "mixed_64", "all_zero_64"].contains(&c.name.as_str())) {
        let ix = Instruction { program_id:program, accounts:vec![], data:case.input };
        let mut limit = vec![2u8];
        limit.extend_from_slice(&1_400_000u32.to_le_bytes());
        let budget = Instruction { program_id:Pubkey::from_str("ComputeBudget111111111111111111111111111111").unwrap(),
            accounts:vec![], data:limit };
        let tx = Transaction::new(&[&payer],Message::new(&[budget,ix],Some(&payer.pubkey())),svm.latest_blockhash());
        let meta = svm.send_transaction(tx).unwrap_or_else(|e| panic!("{} failed: {e:?}",case.name));
        assert_eq!(meta.return_data.program_id,program,"{}",case.name);
        assert_eq!(meta.return_data.data,case.expected,"{}",case.name);
        let remaining: Vec<u64> = meta.logs.iter().filter_map(|line| {
            let value = line.strip_prefix("Program consumption: ")?.split_whitespace().next()?;
            Some(value.parse::<u64>().expect("CU reading"))
        }).collect();
        assert_eq!(remaining.len(),7,"{} logs: {:?}",case.name,meta.logs);
        let intervals: Vec<u64> = remaining.windows(2).map(|p| {
            assert!(p[0]>=p[1],"CU must decrease"); p[0]-p[1]
        }).collect();
        rows.push(serde_json::json!({"name":case.name,"total":meta.compute_units_consumed,
            "remaining":remaining,"intervals":intervals}));
    }
    assert_eq!(rows.len(),5);
    std::fs::write(metrics,serde_json::to_vec_pretty(&rows).unwrap()).unwrap();
    println!("{} RMSNorm phase cases passed",rows.len());
}
