use super::token_fixture::TokenFixture;
use super::*;

// Run the same adversarial transactions against each real application. Every
// case snapshots every account in the instruction, including both exchange
// legs, and requires failure without persisted state/token/lamport changes.
pub(super) fn matrix(
    f: &mut TokenFixture,
    original: Instruction,
    legs: &[(usize, usize, usize)],
    alternate_actor_error: u32,
    stem: &str,
) {
    let mut cases = Vec::new();
    let snapshot = |f: &TokenFixture, ix: &Instruction| {
        ix.accounts
            .iter()
            .map(|m| (m.pubkey, f.svm.get_account(&m.pubkey)))
            .collect::<Vec<_>>()
    };
    let mut reject = |f: &mut TokenFixture, ix: Instruction, code: u32, label: String| {
        let before = snapshot(f, &ix);
        let canonical = snapshot(f, &original);
        let error = f.send(&[ix.clone()]).unwrap_err();
        assert_eq!(
            error.err,
            TransactionError::InstructionError(0, InstructionError::Custom(code)),
            "{stem}/{label}: {:?}",
            error.meta.logs
        );
        assert_eq!(
            snapshot(f, &ix),
            before,
            "{stem}/{label}: passed account changed"
        );
        assert_eq!(
            snapshot(f, &original),
            canonical,
            "{stem}/{label}: canonical account changed"
        );
        cases.push(serde_json::json!({"case":label,"error":code,"all_accounts_unchanged":true}));
    };
    for count in [0, 1, 2, 3, 13] {
        let mut ix = original.clone();
        ix.accounts.resize(count, original.accounts[1].clone());
        reject(f, ix, 1, format!("account-count-{count}"));
    }
    let mut missing = original.clone();
    missing.accounts.truncate(4);
    reject(f, missing, 12, "missing-effect-accounts".into());
    for length in [0, 1, original.data.len() - 1, original.data.len() + 1] {
        let mut ix = original.clone();
        ix.data.resize(length, 0);
        reject(f, ix, 2, format!("instruction-length-{length}"));
    }
    for (offset, value, label) in [
        (0, 2, "mode"),
        (1, 255, "tag"),
        (original.data.len() - 1, 1, "padding"),
    ] {
        let mut ix = original.clone();
        if label == "padding" {
            assert_eq!(ix.data[offset], 0);
        }
        ix.data[offset] = value;
        reject(f, ix, 2, format!("instruction-{label}"));
    }
    let mut unsigned = original.clone();
    unsigned.accounts[1].is_signer = false;
    reject(f, unsigned, 257, "unsigned-actor".into());
    let mut actor = original.clone();
    actor.accounts[1].pubkey = if original.accounts[1].pubkey == f.actor.pubkey() {
        f.attacker.pubkey()
    } else {
        f.actor.pubkey()
    };
    reject(f, actor, alternate_actor_error, "substituted-actor".into());
    let mut readonly = original.clone();
    readonly.accounts[0].is_writable = false;
    reject(f, readonly, 5, "readonly-state".into());
    let mut program = original.clone();
    program.accounts[2].pubkey = Pubkey::default();
    reject(f, program, 10, "wrong-token-program".into());
    let wrong_pda = Pubkey::new_unique();
    f.svm.airdrop(&wrong_pda, 1_000_000).unwrap();
    let mut custody = original.clone();
    custody.accounts[3].pubkey = wrong_pda;
    reject(f, custody, 11, "wrong-custody-pda".into());
    // Check every alias pair, including cross-leg aliases in the exchange.
    for i in 0..original.accounts.len() {
        for j in i + 1..original.accounts.len() {
            let mut ix = original.clone();
            ix.accounts[j] = ix.accounts[i].clone();
            reject(f, ix, 6, format!("alias-{i}-{j}"));
        }
    }
    let state = f.svm.get_account(&f.state.pubkey()).unwrap();
    let mut owner = state.clone();
    owner.owner = Pubkey::new_unique();
    f.svm.set_account(f.state.pubkey(), owner).unwrap();
    reject(f, original.clone(), 3, "state-owner".into());
    f.svm.set_account(f.state.pubkey(), state.clone()).unwrap();
    for offset in 0..20 {
        let mut account = state.clone();
        account.data[offset] ^= 1;
        f.svm.set_account(f.state.pubkey(), account).unwrap();
        reject(f, original.clone(), 4, format!("state-header-{offset}"));
    }
    for length in [0, 1, state.data.len() - 1, state.data.len() + 1] {
        let mut account = state.clone();
        account.data.resize(length, 0);
        f.svm.set_account(f.state.pubkey(), account).unwrap();
        reject(f, original.clone(), 4, format!("state-length-{length}"));
    }
    let mut bad_tag = state.clone();
    bad_tag.data[20] = 255;
    f.svm.set_account(f.state.pubkey(), bad_tag).unwrap();
    reject(f, original.clone(), 4, "state-tag".into());
    f.svm.set_account(f.state.pubkey(), state).unwrap();
    for (leg, &(source, destination, mint)) in legs.iter().enumerate() {
        for (role, index, authority_error) in
            [("source", source, 16), ("destination", destination, 17)]
        {
            let key = original.accounts[index].pubkey;
            let account = f.svm.get_account(&key).unwrap();
            let mut ix = original.clone();
            ix.accounts[index].is_writable = false;
            reject(f, ix, 5, format!("leg-{leg}-{role}-readonly"));
            let mut wrong = account.clone();
            wrong.owner = Pubkey::new_unique();
            f.svm.set_account(key, wrong).unwrap();
            reject(
                f,
                original.clone(),
                13,
                format!("leg-{leg}-{role}-program-owner"),
            );
            for length in [0, 164, 166] {
                let mut wrong = account.clone();
                wrong.data.resize(length, 0);
                f.svm.set_account(key, wrong).unwrap();
                reject(
                    f,
                    original.clone(),
                    14,
                    format!("leg-{leg}-{role}-length-{length}"),
                );
            }
            for (offset, value, code, label) in [
                (0, account.data[0] ^ 1, 15, "mint"),
                (32, account.data[32] ^ 1, authority_error, "authority"),
                (108, 0, 14, "uninitialized"),
                (108, 3, 14, "invalid-state"),
                (109, 1, 14, "native-token"),
            ] {
                let mut wrong = account.clone();
                wrong.data[offset] = value;
                f.svm.set_account(key, wrong).unwrap();
                reject(
                    f,
                    original.clone(),
                    code,
                    format!("leg-{leg}-{role}-{label}"),
                );
            }
            f.svm.set_account(key, account).unwrap();
        }
        let key = original.accounts[mint].pubkey;
        let account = f.svm.get_account(&key).unwrap();
        let mut wrong = account.clone();
        wrong.owner = Pubkey::new_unique();
        f.svm.set_account(key, wrong).unwrap();
        reject(f, original.clone(), 13, format!("leg-{leg}-mint-owner"));
        for length in [0, 81, 83] {
            let mut wrong = account.clone();
            wrong.data.resize(length, 0);
            f.svm.set_account(key, wrong).unwrap();
            reject(
                f,
                original.clone(),
                14,
                format!("leg-{leg}-mint-length-{length}"),
            );
        }
        let mut wrong = account.clone();
        wrong.data[45] = 0;
        f.svm.set_account(key, wrong).unwrap();
        reject(
            f,
            original.clone(),
            14,
            format!("leg-{leg}-mint-uninitialized"),
        );
        f.svm.set_account(key, account.clone()).unwrap();
        let substitute = Pubkey::new_unique();
        f.svm.set_account(substitute, account).unwrap();
        let mut ix = original.clone();
        ix.accounts[mint].pubkey = substitute;
        reject(f, ix, 15, format!("leg-{leg}-mint-key"));
    }
    // Restoration is also checked by successfully running the valid operation.
    f.send(&[original]).unwrap();
    println!(
        "{stem}: {} adversarial validation cases passed",
        cases.len()
    );
    std::fs::write(
        format!("build/{stem}-validation.json"),
        serde_json::to_vec_pretty(&cases).unwrap(),
    )
    .unwrap();
}
