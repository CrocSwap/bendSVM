use super::*;

#[test]
fn structured_codec_schema_matrix_executes_in_sbf() {
    #[derive(Deserialize)]
    struct Case { input: Vec<u8>, valid: bool }
    let cases: Vec<Case> = serde_json::from_slice(
        &std::fs::read("build/codec-structures-runtime-matrix.json").unwrap(),
    ).unwrap();
    assert!(cases.len() > 1000);
    let mut svm = crate::test_svm().with_transaction_history(0);
    let program = Pubkey::new_unique();
    svm.add_program_from_file(program, "build/codec-structures-runtime.so").unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let mut rejected = 0;
    for (i, case) in cases.iter().enumerate() {
        let instruction = Instruction { program_id: program, accounts: vec![], data: case.input.clone() };
        let transaction = Transaction::new(&[&payer], Message::new(&[instruction], Some(&payer.pubkey())), svm.latest_blockhash());
        match svm.send_transaction(transaction) {
            Ok(meta) => {
                assert!(case.valid, "malformed case {i} accepted");
                assert_eq!(meta.return_data.data, case.input[1..], "case {i}");
            }
            Err(error) => {
                assert!(!case.valid, "canonical case {i} rejected: {error:?}");
                assert_eq!(error.err, TransactionError::InstructionError(0, InstructionError::Custom(2)));
                rejected += 1;
            }
        }
    }
    println!("Structured codecs: {} SBF cases, {rejected} canonical rejections", cases.len());
}
