use super::*;

#[test]
fn arbitrary_program_cpi_permissions_signers_and_rollback() {
    let mut svm = crate::test_svm().with_transaction_history(0);
    let caller = Pubkey::new_unique();
    let callee = Pubkey::new_unique();
    svm.add_program_from_file(caller, "build/cpi.so").unwrap();
    svm.add_program_from_file(callee, "build/cpi-callee.so")
        .unwrap();
    let payer = Keypair::new();
    let actor = Keypair::new();
    let state = Keypair::new();
    let target = Pubkey::new_unique();
    let (custody, _) = Pubkey::find_program_address(&[b"bend", state.pubkey().as_ref()], &caller);
    for key in [payer.pubkey(), actor.pubkey(), custody] {
        svm.airdrop(&key, 1_000_000_000).unwrap();
    }
    let layout: serde_json::Value =
        serde_json::from_slice(&std::fs::read("build/cpi.interface.json").unwrap()).unwrap();
    assert_eq!(layout["effects"], "cpi-v1");
    svm.set_account(
        state.pubkey(),
        Account {
            lamports: 1_000_000,
            data: vec![0; layout["stateBytes"].as_u64().unwrap() as usize],
            owner: caller,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    svm.set_account(
        target,
        Account {
            lamports: 1_000_000,
            data: vec![0; 4],
            owner: callee,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    // Canonical Cpi.Invoke: tagged Key/Bytes64/Metas/Meta records, little-endian
    // U32 fields, strict Bool bytes. The TS client independently checks encoding.
    let ix = |initialize: bool, pda: bool, fail: bool, amount: u32, mutation: u8| {
        let program_key = if mutation == 1 { target } else { callee };
        let mut data = vec![if initialize { 0 } else { 1 }, 0, 1];
        data.extend(2u32.to_le_bytes());
        data.push(0);
        data.extend(program_key.to_bytes());
        data.extend((if mutation == 2 { 65u32 } else { 5 }).to_le_bytes());
        data.push(0);
        data.push(if fail { 1 } else { 0 });
        data.extend(amount.to_le_bytes());
        data.resize(data.len() + 59, 0);
        if mutation == 3 {
            *data.last_mut().unwrap() = 1;
        }
        data.extend((if mutation == 4 { 9u32 } else { 2 }).to_le_bytes());
        data.push(0);
        for i in 0..8 {
            let (index, key, writable, signer) = if i == 0 {
                if mutation == 5 {
                    (0, state.pubkey(), true, false)
                } else {
                    (4, target, true, false)
                }
            } else if i == 1 {
                if mutation == 6 {
                    (4, target, false, true)
                } else if pda {
                    (3, custody, false, mutation != 7)
                } else {
                    (1, actor.pubkey(), false, mutation != 7)
                }
            } else {
                (0, Pubkey::default(), false, false)
            };
            data.push(0);
            data.extend((index as u32).to_le_bytes());
            data.push(0);
            data.extend(key.to_bytes());
            data.push(u8::from(writable));
            data.push(u8::from(signer));
        }
        assert_eq!(
            data.len(),
            layout["instructionBytes"].as_u64().unwrap() as usize
        );
        Instruction {
            program_id: caller,
            accounts: vec![
                AccountMeta::new(state.pubkey(), initialize),
                AccountMeta::new_readonly(actor.pubkey(), true),
                AccountMeta::new_readonly(callee, false),
                AccountMeta::new_readonly(custody, false),
                if mutation == 8 {
                    AccountMeta::new_readonly(target, false)
                } else {
                    AccountMeta::new(target, false)
                },
            ],
            data,
        }
    };
    let send = |svm: &mut LiteSVM, instruction: Instruction| {
        let mut signers = vec![&payer, &actor];
        if instruction.accounts[0].is_signer {
            signers.push(&state);
        }
        svm.send_transaction(Transaction::new(
            &signers,
            Message::new(&[instruction], Some(&payer.pubkey())),
            svm.latest_blockhash(),
        ))
    };
    let snapshot = |svm: &LiteSVM| {
        [state.pubkey(), target, actor.pubkey(), custody].map(|key| svm.get_account(&key))
    };
    send(&mut svm, ix(true, false, false, 3, 0)).unwrap();
    assert_eq!(svm.get_account(&target).unwrap().data, 3u32.to_le_bytes());
    send(&mut svm, ix(false, true, false, 5, 0)).unwrap();
    assert_eq!(svm.get_account(&target).unwrap().data, 8u32.to_le_bytes());
    assert_eq!(
        &svm.get_account(&state.pubkey()).unwrap().data[21..],
        2u32.to_le_bytes()
    );
    for mutation in 1..=8 {
        let before = snapshot(&svm);
        assert!(
            send(&mut svm, ix(false, true, false, 100, mutation)).is_err(),
            "mutation {mutation}"
        );
        assert_eq!(
            snapshot(&svm),
            before,
            "mutation {mutation} escaped rollback"
        );
    }
    let before = snapshot(&svm);
    let error = send(&mut svm, ix(false, true, true, 100, 0)).unwrap_err();
    assert!(error
        .meta
        .logs
        .iter()
        .any(|l| l.starts_with(&format!("Program {callee} failed:"))));
    assert_eq!(snapshot(&svm), before, "callee write escaped rollback");
    let meta = send(&mut svm, ix(false, false, false, 2, 0)).unwrap();
    assert_eq!(svm.get_account(&target).unwrap().data, 10u32.to_le_bytes());
    println!(
        "Arbitrary CPI with actor/PDA signing and rollback passed: {} CU",
        meta.compute_units_consumed
    );
}

fn cpi_pair_lifecycle(count: usize) {
    let multi = count > 1;
    let stem = match count {
        1 => "cpi-pair",
        2 => "cpi-multi",
        3 => "cpi-multi-3",
        4 => "cpi-multi-4",
        _ => unreachable!(),
    };
    let layout: serde_json::Value =
        serde_json::from_slice(&std::fs::read(format!("build/{stem}.interface.json")).unwrap())
            .unwrap();
    let mut svm = crate::test_svm().with_transaction_history(0);
    let caller = Pubkey::new_unique();
    let callee = Pubkey::new_unique();
    svm.add_program_from_file(caller, format!("build/{stem}.so"))
        .unwrap();
    svm.add_program_from_file(callee, "build/cpi-callee.so")
        .unwrap();
    let payer = Keypair::new();
    let actor = Keypair::new();
    let state = Keypair::new();
    let second = Keypair::new();
    let third = Keypair::new();
    let fourth = Keypair::new();
    let target = Pubkey::new_unique();
    let custody = Pubkey::find_program_address(&[b"bend", state.pubkey().as_ref()], &caller).0;
    for key in [payer.pubkey(), actor.pubkey(), custody] {
        svm.airdrop(&key, 1_000_000_000).unwrap();
    }
    let state_keys = [&state, &second, &third, &fourth][..count].to_vec();
    for (i, k) in state_keys.iter().enumerate() {
        let size = if multi {
            layout["stateAccounts"][i]["stateBytes"].as_u64().unwrap()
        } else {
            layout["stateBytes"].as_u64().unwrap()
        };
        svm.set_account(
            k.pubkey(),
            Account {
                lamports: 1_000_000,
                data: vec![0; size as usize],
                owner: caller,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    }
    svm.set_account(
        target,
        Account {
            lamports: 2_000_000,
            data: vec![0; 4],
            owner: callee,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let ix = |initialize: bool, first: u8, last: u8, invalid: bool, protected: bool| {
        let index = if protected {
            if multi {
                count + 2
            } else {
                0
            }
        } else {
            count + 3
        };
        let key = if protected {
            if multi {
                state_keys.last().unwrap().pubkey()
            } else {
                state.pubkey()
            }
        } else {
            target
        };
        let mut data = vec![if initialize { 0 } else { 1 }, 0, 1];
        data.extend(2u32.to_le_bytes());
        data.push(0);
        data.extend(callee.to_bytes());
        data.extend(5u32.to_le_bytes());
        data.push(0);
        data.push(first);
        data.extend(3u32.to_le_bytes());
        data.resize(data.len() + 59, 0);
        data.extend(2u32.to_le_bytes());
        data.push(0);
        for i in 0..8 {
            let (idx, k, w, s) = if i == 0 {
                (index, key, 1, 0)
            } else if i == 1 {
                (3, custody, 0, 1)
            } else {
                (0, Pubkey::default(), 0, 0)
            };
            data.push(0);
            data.extend((idx as u32).to_le_bytes());
            data.push(0);
            data.extend(k.to_bytes());
            data.push(w);
            data.push(s);
        }
        data.push(0);
        data.push(last);
        data.extend(5u32.to_le_bytes());
        data.resize(data.len() + 59, 0);
        if invalid {
            *data.last_mut().unwrap() = 1;
        }
        assert_eq!(
            data.len(),
            layout["instructionBytes"].as_u64().unwrap() as usize
        );
        let mut accounts = vec![
            AccountMeta::new(state.pubkey(), initialize),
            AccountMeta::new_readonly(actor.pubkey(), true),
            AccountMeta::new_readonly(callee, false),
            AccountMeta::new_readonly(custody, false),
        ];
        for key in &state_keys[1..] {
            accounts.push(AccountMeta::new(key.pubkey(), initialize));
        }
        accounts.push(AccountMeta::new(target, false));
        Instruction {
            program_id: caller,
            accounts,
            data,
        }
    };
    let send = |svm: &mut LiteSVM, instruction: Instruction| {
        let mut signers = vec![&payer, &actor];
        for k in &state_keys {
            if instruction
                .accounts
                .iter()
                .any(|a| a.pubkey == k.pubkey() && a.is_signer)
            {
                signers.push(k);
            }
        }
        svm.send_transaction(Transaction::new(
            &signers,
            Message::new(&[instruction], Some(&payer.pubkey())),
            svm.latest_blockhash(),
        ))
    };
    let snapshot = |svm: &LiteSVM| {
        std::iter::once(target)
            .chain(state_keys.iter().map(|k| k.pubkey()))
            .chain([actor.pubkey(), custody])
            .map(|k| svm.get_account(&k))
            .collect::<Vec<_>>()
    };
    send(&mut svm, ix(true, 0, 0, false, false)).unwrap();
    assert_eq!(svm.get_account(&target).unwrap().data, 8u32.to_le_bytes());
    for (first, last, invalid, protected) in [
        (0, 1, false, false),
        (0, 0, true, false),
        (0, 0, false, true),
        (2, 6, false, false),
    ] {
        let before = snapshot(&svm);
        let error = send(&mut svm, ix(false, first, last, invalid, protected)).unwrap_err();
        if invalid || protected {
            assert_eq!(
                error.err,
                TransactionError::InstructionError(
                    0,
                    InstructionError::Custom(if protected { 22 } else { 20 })
                )
            );
            assert!(
                !error
                    .meta
                    .logs
                    .iter()
                    .any(|l| l.starts_with(&format!("Program {callee} invoke"))),
                "effects must all validate before the first call"
            );
        } else {
            assert!(error
                .meta
                .logs
                .iter()
                .any(|l| l == &format!("Program {callee} success")));
            assert!(error
                .meta
                .logs
                .iter()
                .any(|l| l.starts_with(&format!("Program {callee} failed:"))));
        }
        assert_eq!(
            snapshot(&svm),
            before,
            "{stem}: failed pair leaked data, size, or state"
        );
    }
    // The second call must see the size and bytes produced by the first call.
    send(&mut svm, ix(false, 2, 3, false, false)).unwrap();
    let grown = svm.get_account(&target).unwrap();
    assert_eq!(grown.data.len(), 8);
    assert_eq!(&grown.data[..4], 16u32.to_le_bytes());
    assert_eq!(&grown.data[4..], 0xbeefu32.to_le_bytes());
    let meta = send(&mut svm, ix(false, 4, 0, false, false)).unwrap();
    assert_eq!(svm.get_account(&target).unwrap().data, 24u32.to_le_bytes());
    for (i, k) in state_keys.iter().enumerate() {
        let account = svm.get_account(&k.pubkey()).unwrap();
        let payload_offset = if multi && i > 0 { 53 } else { 21 };
        if multi && i > 0 {
            assert_eq!(&account.data[20..52], state.pubkey().as_ref());
        }
        assert_eq!(
            &account.data[payload_offset..],
            (3u32 * (i as u32 + 1)).to_le_bytes()
        );
    }
    std::fs::write(format!("build/{stem}-validation.json"),serde_json::to_vec_pretty(&serde_json::json!({"stateAccounts":state_keys.len(),"twoCallRollback":true,"preflightBeforeFirstCall":true,"managedStateWriteRejected":true,"growThenRead":true,"shrinkThenRead":true,"resizeRollback":true,"finalPairCU":meta.compute_units_consumed})).unwrap()).unwrap();
    println!(
        "{stem}: two-call rollback and grow/shrink propagation passed, {} CU",
        meta.compute_units_consumed
    );
}

#[test]
fn two_arbitrary_cpis_rollback_and_propagate_external_resize() {
    cpi_pair_lifecycle(1);
}

#[test]
fn multi_state_arbitrary_cpis_rollback_and_propagate_external_resize() {
    for count in [2, 3, 4] {
        cpi_pair_lifecycle(count);
    }
}
