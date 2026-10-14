use agave_feature_set::FeatureSet;
use litesvm::LiteSVM;
use serde_json::{json, Value};
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const EXPECTED_CASES: usize = 15;

fn bytes(value: &Value) -> Vec<u8> {
    value.as_array().unwrap().iter().map(|v| u8::try_from(v.as_u64().unwrap()).unwrap()).collect()
}

fn modern(features: &FeatureSet) -> LiteSVM {
    // Builtins and the program runtime environment must be created after the
    // feature set is chosen; LiteSVM::new() fixes them to its mainnet features.
    LiteSVM::default()
        .with_feature_set(features.clone())
        .with_builtins()
        .with_lamports(1_000_000_000_000_000)
        .with_sysvars()
        .with_feature_accounts()
        .with_default_programs()
        .with_sigverify(true)
        .with_blockhash_check(true)
        .with_transaction_history(0)
}

fn main() {
    let mut args = std::env::args().skip(1).peekable();
    let directory = args.next().expect("usage: bend-modern-library-runner run-directory [--features all-enabled|mainnet] [observe.so ...]");
    let mut feature_policy = "all-enabled".to_string();
    if args.peek().map(String::as_str) == Some("--features") {
        args.next();
        feature_policy = args.next().expect("--features needs all-enabled or mainnet");
    }
    let observe: Vec<String> = args.collect();
    let elf = std::fs::read(format!("{directory}/mixed-library.so")).unwrap();
    assert!(elf.len() >= 64);
    assert_eq!(&elf[..7], b"\x7fELF\x02\x01\x01");
    assert_eq!(u16::from_le_bytes(elf[16..18].try_into().unwrap()), 3);
    let machine = u16::from_le_bytes(elf[18..20].try_into().unwrap());
    let flags = u32::from_le_bytes(elf[48..52].try_into().unwrap());
    assert!(matches!((machine, flags), (247, 3) | (263, 0) | (247, 0)), "unexpected SBF header {machine}/{flags}");
    let fixtures: Value = serde_json::from_slice(&std::fs::read(format!("{directory}/cases.json")).unwrap()).unwrap();
    let fixtures = fixtures.as_array().unwrap();
    assert_eq!(fixtures.len(), EXPECTED_CASES, "fixture case count");
    let features = match feature_policy.as_str() {
        "all-enabled" => FeatureSet::all_enabled(),
        "mainnet" => LiteSVM::mainnet_feature_set(),
        other => panic!("unknown feature policy {other}"),
    };
    let mut feature_ids: Vec<String> = features.active().keys().map(|id| id.to_string()).collect();
    feature_ids.sort();

    // Loader observations only: the modern loader accepts an ELF with an
    // unresolved import, so interface refusal must happen at link time.
    let mut observed = Vec::new();
    for file in &observe {
        let bytes = std::fs::read(file).unwrap();
        let load = match modern(&features).add_program(Address::new_unique(), &bytes) {
            Ok(()) => json!({"path": file, "accepted": true}),
            Err(error) => json!({"path": file, "accepted": false, "error": format!("{error:?}")}),
        };
        observed.push(load);
    }

    // Observation only: LiteSVM's default mainnet feature configuration.
    let mainnet_load = match LiteSVM::new().add_program(Address::new_unique(), &elf) {
        Ok(()) => json!({"accepted": true}),
        Err(error) => json!({"accepted": false, "error": format!("{error:?}")}),
    };

    let mut runs = Vec::new();
    for _ in 0..3 {
        let mut svm = modern(&features);
        let program = Address::new_unique();
        svm.add_program(program, &elf).expect("modern v3 loader acceptance");
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
        let mut cases = Vec::new();
        for case in fixtures {
            let ix = Instruction { program_id: program, accounts: vec![], data: bytes(&case["data"]) };
            let tx = Transaction::new(&[&payer], Message::new(&[ix], Some(&payer.pubkey())), svm.latest_blockhash());
            let simulated = svm.simulate_transaction(tx.clone()).unwrap_or_else(|e| panic!("{} simulate: {e:?}", case["name"]));
            let result = svm.send_transaction(tx).unwrap_or_else(|e| panic!("{} submit: {e:?}", case["name"]));
            let expected = bytes(&case["expected"]);
            assert_eq!(result.return_data.program_id, program);
            assert_eq!(result.return_data.data, expected, "{}", case["name"]);
            assert_eq!(simulated.meta.return_data.program_id, program, "{} simulation", case["name"]);
            assert_eq!(simulated.meta.return_data.data, expected, "{} simulation", case["name"]);
            assert_eq!(simulated.meta.compute_units_consumed, result.compute_units_consumed);
            cases.push(json!({"name":case["name"], "cu":result.compute_units_consumed, "returnData":expected}));
        }
        runs.push(cases);
    }
    assert_eq!(runs[0], runs[1]);
    assert_eq!(runs[0], runs[2]);
    let max_cu = runs[0].iter().map(|case| case["cu"].as_u64().unwrap()).max().unwrap();
    let report = json!({"passed":true, "cases":fixtures.len(), "maxCu":max_cu,
        "litesvm":"0.13.0", "agaveFeatureSet":"4.0.0",
        "runtimePatches":[], "featureSet":feature_policy, "elfMachine":machine, "elfFlags":flags, "activeFeatureIds":feature_ids,
        "loaderObservations":observed, "mainnetFeatureLoad":mainnet_load, "networkValidation":false, "runs":runs});
    std::fs::write(format!("{directory}/runtime-report.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    println!("{} Rust/Bend SBPF scenarios passed in simulation and submission, three runs; max {max_cu} CU; {} loader observations",
        fixtures.len(), observe.len());
}
