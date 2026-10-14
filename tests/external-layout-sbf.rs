use litesvm::LiteSVM;
use solana_account::Account;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

#[test]
fn standalone_borrowed_window_reads_large_account_in_sbf() {
    let program = Pubkey::new_unique();
    let account_key = Pubkey::new_unique();
    let payer = Keypair::new();
    let mut svm = LiteSVM::new().with_transaction_history(0);
    svm.add_program_from_file(program, "build/external-layout-sbf.so")
        .expect("run the external-layout TypeScript/native/SBF builder first");
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    let mut data = vec![0u8; 1024 * 1024];
    let header_and_payload: [u8; 71] = [
        0x45, 0x58, 0x56, 0x31, 0x01, 0x02, 0x00, 0x00,
        0x12, 0x34, 0x56, 0x78, 0x01, 0x02, 0x03, 0x04,
        0x05, 0x06, 0x07, 0x08,
        0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
        0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
        0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7,
        0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf,
        0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0xab, 0xcd, 0xef,
    ];
    data[..header_and_payload.len()].copy_from_slice(&header_and_payload);
    svm.set_account(
        account_key,
        Account {
            lamports: 10_000_000_000,
            data,
            owner: program,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let invoke = |svm: &mut LiteSVM, account_key: Pubkey| {
        let instruction = Instruction {
            program_id: program,
            accounts: vec![AccountMeta::new(account_key, false)],
            data: vec![],
        };
        let tx = Transaction::new(
            &[&payer],
            Message::new(&[instruction], Some(&payer.pubkey())),
            svm.latest_blockhash(),
        );
        svm.send_transaction(tx)
    };

    let rejected_unchanged = |svm: &mut LiteSVM, account_key: Pubkey, data: Vec<u8>, code: u32| {
        svm.set_account(
            account_key,
            Account {
                lamports: 10_000_000_000,
                data: data.clone(),
                owner: program,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        let before = svm.get_account(&account_key).unwrap().data;
        let error = invoke(svm, account_key).unwrap_err();
        assert_eq!(
            error.err,
            TransactionError::InstructionError(0, InstructionError::Custom(code))
        );
        assert_eq!(svm.get_account(&account_key).unwrap().data, before);
    };

    let meta = invoke(&mut svm, account_key).expect("synthetic external reader succeeds in LiteSVM");

    let mut expected = Vec::with_capacity(27);
    expected.extend_from_slice(&(1024u64 * 1024).to_le_bytes());
    expected.extend_from_slice(&(1024u64 * 1024).to_le_bytes());
    expected.extend_from_slice(&3u64.to_le_bytes());
    expected.extend_from_slice(&[0xab, 0xcd, 0xef]);
    assert_eq!(meta.return_data.program_id, program);
    assert_eq!(meta.return_data.data, expected);
    assert_eq!(
        svm.get_account(&account_key).unwrap().data.len(),
        1024 * 1024,
        "reader leaves the large account allocation unchanged"
    );
    assert_eq!(
        &svm.get_account(&account_key).unwrap().data[..header_and_payload.len()],
        &header_and_payload,
        "reader leaves input bytes unchanged"
    );

    const CAPACITY: usize = 1024;
    const HEADER: usize = 304;
    const ROW_SIZE: usize = 80;
    let dpa1_key = Pubkey::new_unique();
    let mut dpa1 = vec![0u8; HEADER + CAPACITY * ROW_SIZE];
    dpa1[..4].copy_from_slice(b"DPA1");
    dpa1[4] = 1;
    dpa1[40..44].copy_from_slice(&(CAPACITY as u32).to_le_bytes());
    for index in 0..CAPACITY {
        let row = HEADER + index * ROW_SIZE;
        dpa1[row..row + 8].copy_from_slice(&(index as u64).to_le_bytes());
    }
    svm.set_account(
        dpa1_key,
        Account {
            lamports: 10_000_000_000,
            data: dpa1.clone(),
            owner: program,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let dpa1_meta = invoke(&mut svm, dpa1_key).expect("DPA1 external reader succeeds in LiteSVM");
    let mut dpa1_expected = Vec::with_capacity(56);
    for value in [
        (HEADER + CAPACITY * ROW_SIZE) as u64,
        (HEADER + CAPACITY * ROW_SIZE) as u64,
        (CAPACITY * ROW_SIZE) as u64,
        CAPACITY as u64,
        ROW_SIZE as u64,
        0,
        (CAPACITY - 1) as u64,
    ] {
        dpa1_expected.extend_from_slice(&value.to_le_bytes());
    }
    assert_eq!(dpa1_meta.return_data.data, dpa1_expected);
    assert_eq!(svm.get_account(&dpa1_key).unwrap().data, dpa1, "DPA1 reader leaves repeated rows unchanged");

    let dcr2_key = Pubkey::new_unique();
    let mut dcr2 = vec![0u8; 437];
    dcr2[..4].copy_from_slice(b"DCR2");
    dcr2[4] = 7;
    dcr2[196..200].copy_from_slice(&3u32.to_le_bytes());
    dcr2[208] = 4;
    dcr2[424..436].copy_from_slice(&[0x10, 0x11, 0x12, 0x13, 0x20, 0x21, 0x22, 0x23, 0x30, 0x31, 0x32, 0x33]);
    dcr2[436] = 0x05;
    svm.set_account(
        dcr2_key,
        Account {
            lamports: 10_000_000_000,
            data: dcr2.clone(),
            owner: program,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let dcr2_meta = invoke(&mut svm, dcr2_key).expect("DCR2 external reader succeeds in LiteSVM");
    let mut dcr2_expected = Vec::with_capacity(48);
    for value in [437u64, 437, 3, 3, 1, 5] {
        dcr2_expected.extend_from_slice(&value.to_le_bytes());
    }
    assert_eq!(dcr2_meta.return_data.data, dcr2_expected);
    assert_eq!(svm.get_account(&dcr2_key).unwrap().data, dcr2, "DCR2 reader leaves cells and bitmap unchanged");

    let dcr2_prefix_key = Pubkey::new_unique();
    let dcr2_prefix = dcr2[..430].to_vec();
    svm.set_account(
        dcr2_prefix_key,
        Account {
            lamports: 10_000_000_000,
            data: dcr2_prefix.clone(),
            owner: program,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let prefix_meta = invoke(&mut svm, dcr2_prefix_key).expect("DCR2 prefix reader succeeds in LiteSVM");
    let mut prefix_expected = Vec::with_capacity(48);
    for value in [437u64, 430, 1, 3, 0, 0] {
        prefix_expected.extend_from_slice(&value.to_le_bytes());
    }
    assert_eq!(prefix_meta.return_data.data, prefix_expected);
    assert_eq!(
        svm.get_account(&dcr2_prefix_key).unwrap().data,
        dcr2_prefix,
        "prefix reader preserves the partially allocated account"
    );

    let mut dcr2_extra = dcr2.clone();
    dcr2_extra.push(0);
    rejected_unchanged(&mut svm, Pubkey::new_unique(), dcr2_extra, 4);

    let mut dpa1_truncated = vec![0u8; 464];
    dpa1_truncated[..4].copy_from_slice(b"DPA1");
    dpa1_truncated[4] = 1;
    dpa1_truncated[40..44].copy_from_slice(&2u32.to_le_bytes());
    dpa1_truncated.truncate(463);
    rejected_unchanged(&mut svm, Pubkey::new_unique(), dpa1_truncated, 3);

    let mut dpa1_too_many = vec![0u8; 464];
    dpa1_too_many[..4].copy_from_slice(b"DPA1");
    dpa1_too_many[4] = 1;
    dpa1_too_many[40..44].copy_from_slice(&1025u32.to_le_bytes());
    rejected_unchanged(&mut svm, Pubkey::new_unique(), dpa1_too_many, 3);

    const MAX_ACCOUNT_BYTES: usize = 10 * 1024 * 1024;
    let large_key = Pubkey::new_unique();
    let mut large_prefix = vec![0u8; MAX_ACCOUNT_BYTES];
    large_prefix[..header_and_payload.len()].copy_from_slice(&header_and_payload);
    svm.set_account(
        large_key,
        Account {
            lamports: 10_000_000_000,
            data: large_prefix.clone(),
            owner: program,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let large_meta = invoke(&mut svm, large_key).expect("maximum-size synthetic account succeeds in LiteSVM");
    let mut large_expected = Vec::with_capacity(27);
    large_expected.extend_from_slice(&(MAX_ACCOUNT_BYTES as u64).to_le_bytes());
    large_expected.extend_from_slice(&(MAX_ACCOUNT_BYTES as u64).to_le_bytes());
    large_expected.extend_from_slice(&3u64.to_le_bytes());
    large_expected.extend_from_slice(&[0xab, 0xcd, 0xef]);
    assert_eq!(large_meta.return_data.data, large_expected);
    assert_eq!(svm.get_account(&large_key).unwrap().data, large_prefix);

    rejected_unchanged(
        &mut svm,
        Pubkey::new_unique(),
        header_and_payload[..70].to_vec(),
        5,
    );
}
