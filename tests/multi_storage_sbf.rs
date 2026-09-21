use super::*;

#[test]
fn multiple_state_accounts_commit_together_and_reject_invalid_inputs() {
    let layout: serde_json::Value =
        serde_json::from_slice(&std::fs::read("build/multi-storage.interface.json").unwrap())
            .unwrap();
    let program = Pubkey::new_unique();
    let mut svm = LiteSVM::new().with_transaction_history(0);
    svm.add_program_from_file(program, "build/multi-storage.so")
        .unwrap();
    let payer = Keypair::new();
    let actor = Keypair::new();
    let left = Keypair::new();
    let right = Keypair::new();
    for k in [&payer, &actor] {
        svm.airdrop(&k.pubkey(), 1_000_000_000).unwrap();
    }
    for (i, k) in [&left, &right].iter().enumerate() {
        svm.set_account(
            k.pubkey(),
            Account {
                lamports: 1_000_000,
                data: vec![0; layout["stateAccounts"][i]["stateBytes"].as_u64().unwrap() as usize],
                owner: program,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    }
    let instruction = |initialize: bool, a: u32, b: u32| {
        let mut data = vec![if initialize { 0 } else { 1 }, 0];
        data.extend(a.to_le_bytes());
        data.extend(b.to_le_bytes());
        Instruction {
            program_id: program,
            accounts: vec![
                AccountMeta::new(left.pubkey(), initialize),
                AccountMeta::new_readonly(actor.pubkey(), true),
                AccountMeta::new(right.pubkey(), initialize),
            ],
            data,
        }
    };
    let send = |svm: &mut LiteSVM, ix: Instruction| {
        let mut signers = vec![&payer, &actor];
        for k in [&left, &right] {
            if ix
                .accounts
                .iter()
                .any(|m| m.pubkey == k.pubkey() && m.is_signer)
            {
                signers.push(k);
            }
        }
        let tx = Transaction::new(
            &signers,
            Message::new(&[ix], Some(&payer.pubkey())),
            svm.latest_blockhash(),
        );
        svm.send_transaction(tx)
    };
    let snapshot = |svm: &LiteSVM| {
        [
            svm.get_account(&left.pubkey()).unwrap(),
            svm.get_account(&right.pubkey()).unwrap(),
        ]
    };
    // All state addresses must authorize initialization, before either is written.
    let before = snapshot(&svm);
    let mut ix = instruction(true, 7, 11);
    ix.accounts[2].is_signer = false;
    assert!(send(&mut svm, ix).is_err());
    assert_eq!(snapshot(&svm), before);
    send(&mut svm, instruction(true, 7, 11)).unwrap();
    for (i, expected) in [7u32, 11].iter().enumerate() {
        let state = &snapshot(&svm)[i];
        let header: Vec<u8> =
            serde_json::from_value(layout["stateAccounts"][i]["header"].clone()).unwrap();
        assert_eq!(&state.data[..20], header);
        assert_eq!(state.data[20], 0);
        assert_eq!(&state.data[21..25], expected.to_le_bytes());
    }
    let initialized = snapshot(&svm);
    assert!(send(&mut svm, instruction(true, 1, 2)).is_err());
    assert_eq!(snapshot(&svm), initialized);
    send(&mut svm, instruction(false, 13, 17)).unwrap();
    let good = snapshot(&svm);
    // Invalid secondary account must never partially update the primary.
    for mode in 0..6 {
        let mut ix = instruction(false, 99, 100);
        match mode {
            0 => ix.accounts[2].is_writable = false,
            1 => ix.accounts[2] = AccountMeta::new(left.pubkey(), false),
            2 => {
                ix.accounts.pop();
            }
            3 => {
                let mut a = good[1].clone();
                a.owner = Pubkey::new_unique();
                svm.set_account(right.pubkey(), a).unwrap();
            }
            4 => {
                let mut a = good[1].clone();
                a.data[4] ^= 1;
                svm.set_account(right.pubkey(), a).unwrap();
            }
            _ => {
                let mut a = good[1].clone();
                a.data.pop();
                svm.set_account(right.pubkey(), a).unwrap();
            }
        }
        let before = snapshot(&svm);
        assert!(send(&mut svm, ix).is_err());
        assert_eq!(snapshot(&svm), before);
        svm.set_account(right.pubkey(), good[1].clone()).unwrap();
    }
    let mut rejected = instruction(false, 0, 0);
    rejected.data[1] = 1;
    assert!(send(&mut svm, rejected).is_err());
    assert_eq!(snapshot(&svm), good);
    let meta = send(&mut svm, instruction(false, 19, 23)).unwrap();
    let states = snapshot(&svm);
    assert_eq!(&states[0].data[21..25], 19u32.to_le_bytes());
    assert_eq!(&states[1].data[21..25], 23u32.to_le_bytes());
    assert_eq!(meta.return_data.data.len(), 11);
    println!(
        "Multi-storage two-account update: {} CU",
        meta.compute_units_consumed
    );
}

fn larger_multi_storage(count: usize) {
    let stem = format!("build/multi-storage-{count}");
    let layout: serde_json::Value =
        serde_json::from_slice(&std::fs::read(format!("{stem}.interface.json")).unwrap()).unwrap();
    let program = Pubkey::new_unique();
    let mut svm = LiteSVM::new().with_transaction_history(0);
    svm.add_program_from_file(program, format!("{stem}.so"))
        .unwrap();
    let payer = Keypair::new();
    let actor = Keypair::new();
    let states: Vec<_> = (0..count).map(|_| Keypair::new()).collect();
    for k in [&payer, &actor] {
        svm.airdrop(&k.pubkey(), 1_000_000_000).unwrap();
    }
    for (i, k) in states.iter().enumerate() {
        svm.set_account(
            k.pubkey(),
            Account {
                lamports: 1_000_000,
                data: vec![0; layout["stateAccounts"][i]["stateBytes"].as_u64().unwrap() as usize],
                owner: program,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    }
    let slot = |i: usize| if i == 0 { 0 } else { i + 1 };
    let ix = |initialize: bool, tag: u8| {
        let mut accounts = vec![
            AccountMeta::new(states[0].pubkey(), initialize),
            AccountMeta::new_readonly(actor.pubkey(), true),
        ];
        accounts.extend(
            states[1..]
                .iter()
                .map(|k| AccountMeta::new(k.pubkey(), initialize)),
        );
        let mut data = vec![if initialize { 0 } else { 1 }, tag];
        for i in 0..count {
            data.extend((if tag == 0 { (i as u32 + 1) * 11 } else { 0 }).to_le_bytes());
        }
        Instruction {
            program_id: program,
            accounts,
            data,
        }
    };
    let send = |svm: &mut LiteSVM, instruction: Instruction| {
        let mut signers = vec![&payer];
        for k in std::iter::once(&actor).chain(states.iter()) {
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
        states
            .iter()
            .chain(std::iter::once(&actor))
            .map(|k| svm.get_account(&k.pubkey()).unwrap())
            .collect::<Vec<_>>()
    };
    let reject = |result: TransactionResult, code: u32| {
        assert_eq!(
            result.unwrap_err().err,
            TransactionError::InstructionError(0, InstructionError::Custom(code))
        );
    };
    let zero = snapshot(&svm);
    for i in 0..count {
        let mut instruction = ix(true, 0);
        instruction.accounts[slot(i)].is_signer = false;
        reject(send(&mut svm, instruction), 7);
        assert_eq!(snapshot(&svm), zero);
    }
    send(&mut svm, ix(true, 0)).unwrap();
    let initial = snapshot(&svm);
    for (i, account) in initial[..count].iter().enumerate() {
        let header: Vec<u8> =
            serde_json::from_value(layout["stateAccounts"][i]["header"].clone()).unwrap();
        assert_eq!(&account.data[..20], header);
        assert_eq!(&account.data[21..], ((i as u32 + 1) * 11).to_le_bytes());
    }
    let meta = send(&mut svm, ix(false, 1)).unwrap();
    let rotated = snapshot(&svm);
    // Rotation proves that every account is decoded into the correct field,
    // consumed by Bend, then projected back into its own schema/account.
    let mut reply = vec![0];
    for (i, account) in rotated[..count].iter().enumerate() {
        let expected = (((i + 1) % count) as u32 + 1) * 11;
        assert_eq!(&account.data[21..], expected.to_le_bytes());
        reply.push(0);
        reply.extend(expected.to_le_bytes());
    }
    assert_eq!(meta.return_data.data, reply);
    let mut cases = 0;
    for i in 0..count {
        for mode in 0..7 {
            let mut instruction = ix(false, 0);
            let mut account = rotated[i].clone();
            let code = match mode {
                0 => {
                    instruction.accounts[slot(i)].is_writable = false;
                    5
                }
                1 => {
                    account.owner = Pubkey::new_unique();
                    3
                }
                2 => {
                    account.data[4] ^= 1;
                    4
                }
                3 => {
                    account.data.pop();
                    4
                }
                4 => {
                    account.data[20] = 1;
                    4
                }
                5 => {
                    // LiteSVM rejects fabricated executable accounts with an
                    // application owner; substitute a real loaded program.
                    instruction.accounts[slot(i)] = AccountMeta::new_readonly(program, false);
                    3
                }
                _ => {
                    account.data.push(0);
                    4
                }
            };
            svm.set_account(states[i].pubkey(), account).unwrap();
            let before = snapshot(&svm);
            reject(send(&mut svm, instruction), code);
            assert_eq!(snapshot(&svm), before);
            svm.set_account(states[i].pubkey(), rotated[i].clone())
                .unwrap();
            cases += 1;
        }
    }
    // Every alias pair, including the actor, must fail without touching state.
    for i in 0..count + 1 {
        for j in i + 1..count + 1 {
            let mut instruction = ix(false, 0);
            instruction.accounts[j] = instruction.accounts[i].clone();
            reject(send(&mut svm, instruction), 6);
            assert_eq!(snapshot(&svm), rotated);
            cases += 1;
        }
    }
    for i in 0..count {
        for j in i + 1..count {
            let mut instruction = ix(false, 0);
            instruction.accounts.swap(slot(i), slot(j));
            reject(send(&mut svm, instruction), 4);
            assert_eq!(snapshot(&svm), rotated);
            cases += 1;
        }
    }
    let mut short = ix(false, 0);
    short.accounts.pop();
    reject(send(&mut svm, short), 1);
    let mut extra = ix(false, 0);
    extra.accounts.push(extra.accounts[0].clone());
    reject(send(&mut svm, extra), 1);
    reject(send(&mut svm, ix(false, 2)), 298);
    assert_eq!(snapshot(&svm), rotated);
    send(&mut svm, ix(false, 0)).unwrap();
    assert_eq!(snapshot(&svm), initial);
    println!(
        "{count}-state storage: {cases} account rejection cases; rotate {} CU",
        meta.compute_units_consumed
    );
    std::fs::write(
        format!("{stem}-validation.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "stateAccounts": count,
            "accountRejectionCases": cases,
            "initializationSignatureRejections": count,
            "rotationCU": meta.compute_units_consumed,
            "aggregateReplyChecked": true,
            "unchangedAccountsOnRejection": true
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn three_state_accounts_decode_rotate_and_validate_every_slot() {
    larger_multi_storage(3);
}

#[test]
fn four_state_accounts_decode_rotate_and_validate_every_slot() {
    larger_multi_storage(4);
}

#[test]
fn multi_state_token_effects_commit_and_roll_back_both_legs() {
    use super::token_fixture::TokenFixture;
    for count in [2usize, 3, 4] {
        let stem = format!("multi-token-{count}");
        let mut f = TokenFixture::new(&stem);
        let layout: serde_json::Value =
            serde_json::from_slice(&std::fs::read(format!("build/{stem}.interface.json")).unwrap())
                .unwrap();
        let extra: Vec<_> = (1..count).map(|_| Keypair::new()).collect();
        let refs: Vec<_> = extra.iter().collect();
        let ix = |f: &TokenFixture, initialize: bool, deposit: u64, withdrawal: u64| {
            let mut accounts = vec![
                AccountMeta::new(f.state.pubkey(), initialize),
                AccountMeta::new_readonly(f.actor.pubkey(), true),
                AccountMeta::new_readonly(spl_token::id(), false),
                AccountMeta::new_readonly(f.custody, false),
            ];
            accounts.extend(
                extra
                    .iter()
                    .map(|k| AccountMeta::new(k.pubkey(), initialize)),
            );
            accounts.extend([
                AccountMeta::new(f.user_token.pubkey(), false),
                AccountMeta::new(f.vault_token.pubkey(), false),
                AccountMeta::new_readonly(f.mint.pubkey(), false),
            ]);
            let mut data = vec![if initialize { 0 } else { 1 }, 0, 0];
            data.extend(f.mint.pubkey().to_bytes());
            data.push(0);
            data.extend(deposit.to_le_bytes());
            data.push(0);
            data.extend(withdrawal.to_le_bytes());
            Instruction {
                program_id: f.program,
                accounts,
                data,
            }
        };
        let snapshot = |f: &TokenFixture| {
            let mut result = f.snapshot();
            result.extend(extra.iter().map(|k| f.svm.get_account(&k.pubkey())));
            result.push(f.svm.get_account(&f.actor.pubkey()));
            result.push(f.svm.get_account(&f.custody));
            result
        };
        let check_counts = |f: &TokenFixture, expected: u32| {
            for (i, key) in std::iter::once(f.state.pubkey())
                .chain(extra.iter().map(|k| k.pubkey()))
                .enumerate()
            {
                let account = f.svm.get_account(&key).unwrap();
                let header: Vec<u8> =
                    serde_json::from_value(layout["stateAccounts"][i]["header"].clone()).unwrap();
                assert_eq!(&account.data[..20], header);
                assert_eq!(&account.data[21..25], expected.to_le_bytes());
            }
        };
        let mut initialize = vec![f.create(f.state.pubkey(), f.size, f.program)];
        for (i, key) in extra.iter().enumerate() {
            initialize.push(
                f.create(
                    key.pubkey(),
                    layout["stateAccounts"][i + 1]["stateBytes"]
                        .as_u64()
                        .unwrap() as usize,
                    f.program,
                ),
            );
        }
        initialize.push(ix(&f, true, 0, 0));
        let mut failed_creation = initialize.clone();
        *failed_creation.last_mut().unwrap() = ix(&f, true, 100, 101);
        let before_creation = snapshot(&f);
        let error = f.send_extra(&failed_creation, &refs).unwrap_err();
        assert_eq!(
            error
                .meta
                .logs
                .iter()
                .filter(|l| l.as_str() == "Program log: Instruction: TransferChecked")
                .count(),
            2
        );
        assert_eq!(
            snapshot(&f),
            before_creation,
            "failed initialization must roll back every allocation and token transfer"
        );
        f.send_extra(&initialize, &refs).unwrap();
        check_counts(&f, 1);
        f.send(&[ix(&f, false, 100, 40)]).unwrap();
        assert_eq!(f.balances(), (940, 60));
        check_counts(&f, 2);
        for (i, key) in extra.iter().enumerate() {
            let mut readonly = ix(&f, false, 1, 0);
            readonly.accounts[i + 4].is_writable = false;
            let before = snapshot(&f);
            let error = f.send(&[readonly]).unwrap_err();
            assert_eq!(
                error.err,
                TransactionError::InstructionError(0, InstructionError::Custom(5))
            );
            assert!(!error
                .meta
                .logs
                .iter()
                .any(|l| l == "Program log: Instruction: TransferChecked"));
            assert_eq!(snapshot(&f), before);
            let original = f.svm.get_account(&key.pubkey()).unwrap();
            let mut malformed = original.clone();
            malformed.data[4] ^= 1;
            f.svm.set_account(key.pubkey(), malformed).unwrap();
            let before = snapshot(&f);
            let error = f.send(&[ix(&f, false, 1, 0)]).unwrap_err();
            assert_eq!(
                error.err,
                TransactionError::InstructionError(0, InstructionError::Custom(4))
            );
            assert_eq!(snapshot(&f), before);
            f.svm.set_account(key.pubkey(), original).unwrap();
        }
        // The custody PDA must be derived from the primary, not another state.
        let wrong =
            Pubkey::find_program_address(&[b"bend", extra[0].pubkey().as_ref()], &f.program).0;
        f.svm.airdrop(&wrong, 1_000_000).unwrap();
        let mut wrong_ix = ix(&f, false, 1, 0);
        wrong_ix.accounts[3] = AccountMeta::new_readonly(wrong, false);
        let before = snapshot(&f);
        let error = f.send(&[wrong_ix]).unwrap_err();
        assert_eq!(
            error.err,
            TransactionError::InstructionError(0, InstructionError::Custom(11))
        );
        assert_eq!(snapshot(&f), before);
        // First token leg succeeds; second fails after observing that deposit.
        let before = snapshot(&f);
        let error = f.send(&[ix(&f, false, 100, 161)]).unwrap_err();
        assert_eq!(
            error
                .meta
                .logs
                .iter()
                .filter(|l| l.as_str() == "Program log: Instruction: TransferChecked")
                .count(),
            2
        );
        assert!(error
            .meta
            .logs
            .iter()
            .any(|l| l == &format!("Program {} success", spl_token::id())));
        assert!(error
            .meta
            .logs
            .iter()
            .any(|l| l.starts_with(&format!("Program {} failed:", spl_token::id()))));
        assert_eq!(
            snapshot(&f),
            before,
            "CPI failure leaked a token transfer or one of the state updates"
        );
        check_counts(&f, 2);
        let meta = f.send(&[ix(&f, false, 0, 60)]).unwrap();
        assert_eq!(f.balances(), (1000, 0));
        check_counts(&f, 3);
        let mut reply = vec![0];
        for _ in 0..count {
            reply.push(0);
            reply.extend(3u32.to_le_bytes());
        }
        assert_eq!(meta.return_data.data, reply);
        std::fs::write(format!("build/{stem}-validation.json"),serde_json::to_vec_pretty(&serde_json::json!({"stateAccounts":count,"twoActualCpis":true,"failedInitializationRollsBackAllocations":true,"failedSecondLegRollsBackTokensAndAllState":true,"custodyUsesPrimaryState":true,"maxObservedCU":f.max_cu})).unwrap()).unwrap();
        println!(
            "{count}-state token round-trip/rollback passed; max {} CU",
            f.max_cu
        );
    }
}
