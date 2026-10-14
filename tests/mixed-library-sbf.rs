include!("../build/mixed-library/library.bindings.rs");

use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

const SENTINEL: u64 = 0x1122_3344_5566_7788;
const REPORT_PREFIX_BYTES: usize = 23;

fn expected_report(mode: u8, instruction: &[u8], status: u32, output: &[u8], unchanged: bool) -> Vec<u8> {
    let output_len = if status == BEND_LIBRARY_ABI_OK { BEND_LIBRARY_OUTPUT_BYTES as u64 } else { SENTINEL };
    let mut before = instruction.len() as u32;
    for byte in instruction {
        before = before.wrapping_add(*byte as u32);
    }
    let mut after = before ^ status ^ output_len as u32;
    for byte in output {
        after = after.wrapping_mul(33).wrapping_add(*byte as u32);
    }
    let mut report = vec![1, mode];
    report.extend_from_slice(&status.to_le_bytes());
    report.extend_from_slice(&output_len.to_le_bytes());
    report.push(u8::from(unchanged));
    report.extend_from_slice(&before.to_le_bytes());
    report.extend_from_slice(&after.to_le_bytes());
    report.extend_from_slice(output);
    assert_eq!(report.len(), REPORT_PREFIX_BYTES + BEND_LIBRARY_OUTPUT_BYTES);
    report
}

fn decision(tag: u8, value: u32) -> Vec<u8> {
    let mut bytes = vec![tag];
    bytes.extend_from_slice(&value.to_le_bytes());
    bytes
}

#[test]
fn abi_v1_status_numbers_are_pinned_independently() {
    assert_eq!(BEND_LIBRARY_ABI_OK, 0);
    assert_eq!(BEND_LIBRARY_ABI_NULL, 1);
    assert_eq!(BEND_LIBRARY_ABI_RANGE, 2);
    assert_eq!(BEND_LIBRARY_ABI_ALIAS, 3);
    assert_eq!(BEND_LIBRARY_ABI_MALFORMED_INPUT, 4);
    assert_eq!(BEND_LIBRARY_ABI_SHORT_OUTPUT, 5);
    assert_eq!(BEND_LIBRARY_ABI_MISALIGNED_OUTPUT_LEN, 6);
    assert_eq!(BEND_LIBRARY_ABI_OUTPUT_ENCODING, 7);
}

#[test]
fn rust_and_checked_bend_export_execute_inside_one_sbf_image() {
    let elf = "build/mixed-library/mixed-library.so";
    let mut mismatch_svm = LiteSVM::new().with_transaction_history(0);
    assert!(mismatch_svm.add_program_from_file(Pubkey::new_unique(), "build/mixed-library/schema-mismatch.so").is_err(),
        "LiteSVM must reject an ELF importing the same-root wrong-schema symbol");

    let mut svm = LiteSVM::new().with_transaction_history(0);
    let program = Pubkey::new_unique();
    svm.add_program_from_file(program, elf).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    let sentinel_output = vec![0xa5; BEND_LIBRARY_OUTPUT_BYTES];
    let cases: Vec<(&str, Vec<u8>, u32, Vec<u8>, bool)> = vec![
        ("accepted_zero", vec![0, 0, 1, 0, 0, 0, 0], BEND_LIBRARY_ABI_OK, decision(0, 2), false),
        ("accepted_boundary_40", vec![0, 0, 1, 40, 0, 0, 0], BEND_LIBRARY_ABI_OK, decision(0, 42), false),
        ("refused_boundary_41", vec![0, 0, 1, 41, 0, 0, 0], BEND_LIBRARY_ABI_OK, decision(1, 41), false),
        ("disabled_request", vec![0, 0, 0, 41, 0, 0, 0], BEND_LIBRARY_ABI_OK, decision(1, 41), false),
        ("stop_request", vec![0, 1, 0, 0, 0, 0, 0], BEND_LIBRARY_ABI_OK, decision(1, 0), false),
        ("short_output", vec![1, 0, 1, 0, 0, 0, 0], BEND_LIBRARY_ABI_SHORT_OUTPUT, sentinel_output.clone(), true),
        ("malformed_bool", vec![2, 0, 2, 0, 0, 0, 0], BEND_LIBRARY_ABI_MALFORMED_INPUT, sentinel_output.clone(), true),
        ("malformed_precedes_short_output", vec![3, 0, 2, 0, 0, 0, 0], BEND_LIBRARY_ABI_MALFORMED_INPUT, sentinel_output.clone(), true),
        ("overlapping_buffers", vec![4, 0, 1, 0, 0, 0, 0], BEND_LIBRARY_ABI_ALIAS, sentinel_output.clone(), true),
        ("null_output", vec![5, 0, 1, 0, 0, 0, 0], BEND_LIBRARY_ABI_NULL, sentinel_output.clone(), true),
        ("null_input", vec![6, 0, 1, 0, 0, 0, 0], BEND_LIBRARY_ABI_NULL, sentinel_output.clone(), true),
        ("misaligned_output_len", vec![7, 0, 1, 0, 0, 0, 0], BEND_LIBRARY_ABI_MISALIGNED_OUTPUT_LEN, sentinel_output.clone(), true),
        ("malformed_adt_tag", vec![8, 2, 0, 0, 0, 0, 0], BEND_LIBRARY_ABI_MALFORMED_INPUT, sentinel_output.clone(), true),
        ("malformed_padding", vec![9, 1, 0, 0, 0, 0, 1], BEND_LIBRARY_ABI_MALFORMED_INPUT, sentinel_output.clone(), true),
        ("malformed_length", vec![10, 0, 1, 0, 0, 0], BEND_LIBRARY_ABI_MALFORMED_INPUT, sentinel_output, true),
    ];
    let mut max_cu = 0u64;
    for (name, data, status, output, unchanged) in &cases {
        let ix = Instruction { program_id: program, accounts: Vec::<AccountMeta>::new(), data: data.clone() };
        let tx = Transaction::new(
            &[&payer],
            Message::new(&[ix], Some(&payer.pubkey())),
            svm.latest_blockhash(),
        );
        let result = svm.send_transaction(tx).unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert_eq!(result.return_data.program_id, program, "{name}");
        assert_eq!(result.return_data.data, expected_report(data[0], data, *status, output, *unchanged), "{name}");
        max_cu = max_cu.max(result.compute_units_consumed);
    }
    println!("{} mixed Rust/Bend SBF cases passed; max {max_cu} CU", cases.len());
    std::fs::write(
        "build/mixed-library/litesvm-metrics.json",
        serde_json::to_vec_pretty(&serde_json::json!({
            "cases": cases.len(), "maxCu": max_cu,
            "elfBytes": std::fs::metadata(elf).unwrap().len()
        })).unwrap(),
    ).unwrap();
}
