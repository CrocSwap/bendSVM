//! Run from the repository root. Fresh program/test keys; payer is explicit or
//! fresh; never uses the configured CLI wallet.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_system_interface::instruction as system;
use solana_transaction::Transaction;
use spl_token::{
    instruction as token,
    state::{Account as TokenAccount, Mint},
};
use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    panic::{catch_unwind, resume_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread::sleep,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const DEVNET_URL: &str = "https://api.devnet.solana.com";
const LOCAL_URL: &str = "http://127.0.0.1:18899";

#[derive(Debug, PartialEq)]
struct Cli {
    url: String,
    payer: Option<PathBuf>,
    program: String,
}

const DEFAULT_PROGRAM: &str = "build/queue";

fn parse_args<I, S>(args: I) -> Result<Cli, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut positional = None;
    let mut payer = None;
    let mut program: Option<String> = None;
    let mut args = args.into_iter().map(Into::into);
    while let Some(arg) = args.next() {
        if arg == "--payer" {
            if payer.is_some() {
                return Err("--payer may be supplied only once".into());
            }
            let path = args
                .next()
                .ok_or_else(|| "--payer requires a keypair path".to_string())?;
            if path.starts_with('-') {
                return Err("--payer requires a keypair path, not an option".into());
            }
            payer = Some(PathBuf::from(path));
        } else if let Some(path) = arg.strip_prefix("--payer=") {
            if payer.is_some() {
                return Err("--payer may be supplied only once".into());
            }
            if path.is_empty() || path.starts_with('-') {
                return Err("--payer requires a keypair path".into());
            }
            payer = Some(PathBuf::from(path));
        } else if arg == "--program" || arg.starts_with("--program=") {
            let stem = match arg.strip_prefix("--program=") {
                Some(stem) => stem.to_string(),
                None => args
                    .next()
                    .ok_or_else(|| "--program requires a build stem".to_string())?,
            };
            if stem.is_empty() || stem.starts_with('-') {
                return Err("--program requires a build stem, not an option".into());
            }
            if program.replace(stem).is_some() {
                return Err("--program may be supplied only once".into());
            }
        } else if arg.starts_with('-') {
            return Err(format!("unknown option {arg}"));
        } else if positional.replace(arg).is_some() {
            return Err("exactly one RPC endpoint is required".into());
        }
    }
    let url = positional.ok_or_else(|| {
        format!("Usage: bend-live-queue [{DEVNET_URL}|{LOCAL_URL}] [--payer PATH] [--program STEM]")
    })?;
    if url != DEVNET_URL && url != LOCAL_URL {
        return Err("Only explicit test endpoints are supported".into());
    }
    Ok(Cli {
        url,
        payer,
        program: program.unwrap_or_else(|| DEFAULT_PROGRAM.into()),
    })
}

struct Rpc {
    url: String,
    receipts: Vec<Value>,
    receipt_path: Option<std::path::PathBuf>,
}
impl Rpc {
    fn failure(&self, method: &str, detail: Value) {
        if let Some(receipts) = &self.receipt_path {
            let path = receipts
                .parent()
                .expect("receipt directory")
                .join("failure.json");
            fs::write(
                path,
                serde_json::to_vec_pretty(&json!({
                    "passed": false,
                    "rpc": self.url,
                    "method": method,
                    "detail": detail,
                    "receipts": self.receipts,
                }))
                .unwrap(),
            )
            .unwrap();
        }
    }

    fn flush_receipts(&self) {
        if let Some(path) = &self.receipt_path {
            fs::write(
                path,
                serde_json::to_vec_pretty(&json!({
                    "rpc": self.url,
                    "receipts": self.receipts,
                }))
                .unwrap(),
            )
            .unwrap();
        }
    }

    fn call(&self, method: &str, params: Value) -> Value {
        let body = json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string();
        let mut child = Command::new("curl")
            .args([
                "--fail-with-body",
                "--silent",
                "--show-error",
                "--max-time",
                "30",
                &self.url,
                "-H",
                "Content-Type: application/json",
                "--data-binary",
                "@-",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(body.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        if !output.status.success() {
            let detail = json!({
                "kind": "curl-failure",
                "status": output.status.code(),
                "stderr": String::from_utf8_lossy(&output.stderr),
            });
            self.failure(method, detail.clone());
            panic!("RPC {method}: {detail}");
        }
        let result: Value = match serde_json::from_slice(&output.stdout) {
            Ok(result) => result,
            Err(error) => {
                let detail = json!({
                    "kind": "invalid-json",
                    "error": error.to_string(),
                    "stdout": String::from_utf8_lossy(&output.stdout),
                });
                self.failure(method, detail.clone());
                panic!("RPC {method}: {detail}");
            }
        };
        if let Some(error) = result.get("error") {
            self.failure(method, error.clone());
            panic!("RPC {method}: {result}");
        }
        result["result"].clone()
    }
    fn confirm(&mut self, label: &str, signature: &str, error: Value) {
        let mut status_failures = 0;
        for _ in 0..120 {
            let result = match catch_unwind(AssertUnwindSafe(|| {
                self.call(
                    "getSignatureStatuses",
                    json!([[signature],{"searchTransactionHistory":true}]),
                )
            })) {
                Ok(result) => {
                    status_failures = 0;
                    result
                }
                Err(_payload) => {
                    status_failures += 1;
                    if status_failures < 6 {
                        sleep(Duration::from_secs(2));
                        continue;
                    }
                    self.mark_uncertain(
                        signature,
                        "status lookup failed after submission; inspect the signature before retrying",
                    );
                    self.flush_receipts();
                    panic!(
                        "Status lookup failed for {signature}; do not resubmit before inspecting getSignatureStatuses"
                    );
                }
            };
            let status = &result["value"][0];
            if matches!(
                status["confirmationStatus"].as_str(),
                Some("confirmed" | "finalized")
            ) {
                let expected = status["err"] == error;
                self.update_receipt(signature, |receipt| {
                    receipt["outcome"] = json!(if expected {
                        "confirmed"
                    } else {
                        "unexpected-status"
                    });
                    receipt["status"] = status.clone();
                });
                self.flush_receipts();
                assert!(expected, "{label}: {status}");
                println!("{label}: {signature}");
                return;
            }
            sleep(Duration::from_millis(500));
        }
        self.mark_uncertain(
            signature,
            "confirmation timeout; inspect getSignatureStatuses before retrying",
        );
        self.flush_receipts();
        panic!("Confirmation timed out for {signature}; do not assume transaction failure");
    }
    fn update_receipt(&mut self, signature: &str, update: impl FnOnce(&mut Value)) {
        let receipt = self
            .receipts
            .iter_mut()
            .rev()
            .find(|receipt| receipt["signature"] == signature)
            .expect("signed transaction receipt");
        update(receipt);
    }
    fn mark_uncertain(&mut self, signature: &str, reason: &str) {
        self.update_receipt(signature, |receipt| {
            receipt["outcome"] = json!("uncertain");
            receipt["reason"] = json!(reason);
        });
    }
    fn send(
        &mut self,
        label: &str,
        payer: &Keypair,
        extra: &[&Keypair],
        ixs: &[Instruction],
        error: Value,
    ) {
        let latest = self.call("getLatestBlockhash", json!([{"commitment":"confirmed"}]));
        let blockhash = latest["value"]["blockhash"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let mut signers = vec![payer];
        signers.extend_from_slice(extra);
        let tx = Transaction::new(
            &signers,
            Message::new(ixs, Some(&payer.pubkey())),
            blockhash,
        );
        let wire = bincode::serialize(&tx).unwrap();
        assert!(
            wire.len() <= 1232,
            "{label}: transaction exceeds packet size"
        );
        let encoded = STANDARD.encode(wire);
        let signature = tx.signatures[0].to_string();
        self.receipts.push(json!({
            "label": label,
            "signature": signature,
            "outcome": "pending",
            "note": "signed locally before RPC submission; inspect this signature before retrying after an uncertain response",
        }));
        self.flush_receipts();
        // Submit negative cases too: confirm their on-chain error and rollback.
        let sig = match catch_unwind(AssertUnwindSafe(|| {
            self.call("sendTransaction", json!([encoded,{"encoding":"base64","skipPreflight":true,"preflightCommitment":"confirmed","maxRetries":3}]))
        })) {
            Ok(sig) => sig,
            Err(payload) => {
                self.mark_uncertain(
                    &signature,
                    "sendTransaction response was uncertain; inspect this signature before retrying",
                );
                self.flush_receipts();
                resume_unwind(payload);
            }
        };
        let returned = sig.as_str().expect("sendTransaction signature");
        assert_eq!(
            returned, signature,
            "RPC returned a different signature for the locally signed transaction"
        );
        self.confirm(label, &signature, error);
    }
    fn account(&self, key: Pubkey) -> Value {
        let result = self.call(
            "getAccountInfo",
            json!([key.to_string(),{"encoding":"base64","commitment":"confirmed"}]),
        );
        assert!(!result["value"].is_null(), "Missing account {key}");
        result["value"].clone()
    }
    fn bytes(&self, key: Pubkey) -> Vec<u8> {
        STANDARD
            .decode(self.account(key)["data"][0].as_str().unwrap())
            .unwrap()
    }
    fn create(&self, payer: Pubkey, key: Pubkey, size: usize, owner: Pubkey) -> Instruction {
        let rent = self
            .call("getMinimumBalanceForRentExemption", json!([size]))
            .as_u64()
            .unwrap();
        system::create_account(&payer, &key, rent, size as u64, &owner)
    }
    fn balance(&self, key: Pubkey) -> u64 {
        TokenAccount::unpack(&self.bytes(key)).unwrap().amount
    }
    fn lamports(&self, key: Pubkey) -> u64 {
        self.call(
            "getBalance",
            json!([key.to_string(), {"commitment":"confirmed"}]),
        )["value"]
            .as_u64()
            .expect("getBalance value")
    }
}
fn save_key(dir: &Path, name: &str, key: &Keypair) {
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(dir.join(name))
        .unwrap();
    f.write_all(
        serde_json::to_string(&key.to_bytes().to_vec())
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
}

fn load_supplied_payer(path: &Path) -> Result<Keypair, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("cannot read payer keypair: {error}"))?;
    let mode = metadata.permissions().mode() & 0o777;
    if mode != 0o600 {
        return Err(format!(
            "payer keypair must remain mode 0600 (found {mode:03o})"
        ));
    }
    solana_keypair::read_keypair_file(path)
        .map_err(|error| format!("cannot load payer keypair: {error}"))
}

fn deployment_signature(bytes: &[u8]) -> Option<String> {
    fn find(value: &Value) -> Option<String> {
        match value {
            Value::Object(map) => map
                .get("signature")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| map.values().find_map(find)),
            Value::Array(values) => values.iter().find_map(find),
            _ => None,
        }
    }
    serde_json::from_slice(bytes)
        .ok()
        .and_then(|value| find(&value))
}

fn write_deployment_uncertainty(dir: &Path, program: Pubkey, deployment: &std::process::Output) {
    fs::write(
        dir.join("deployment-uncertain.json"),
        serde_json::to_vec_pretty(&json!({
            "outcome": "uncertain",
            "reason": "solana CLI deployment exited unsuccessfully; inspect deployment.stdout and deployment.stderr before retrying",
            "program": program.to_string(),
            "signature": deployment_signature(&deployment.stdout)
                .or_else(|| deployment_signature(&deployment.stderr)),
            "exitCode": deployment.status.code(),
            "stdoutPath": "deployment.stdout",
            "stderrPath": "deployment.stderr",
        }))
        .unwrap(),
    )
    .unwrap();
}
#[derive(Deserialize)]
struct GeneratedMeta {
    address: String,
    signer: bool,
    writable: bool,
}

#[derive(Deserialize)]
struct GeneratedPlan {
    accounts: Vec<GeneratedMeta>,
    data: String,
}

fn queue_ix(
    program: Pubkey,
    state: Pubkey,
    actor: Pubkey,
    custody: Pubkey,
    collection: Pubkey,
    instruction: &str,
    args: Value,
    mode: &str,
    remaining: Vec<AccountMeta>,
) -> Instruction {
    let request = json!({
        "program": program.to_string(),
        "instruction": instruction,
        "args": args,
        "accounts": {
            "state": state.to_string(),
            "actor": actor.to_string(),
            "tokenProgram": spl_token::id().to_string(),
            "custody": custody.to_string(),
            "collection": collection.to_string(),
        },
        "mode": mode,
        "remaining": remaining.iter().map(|meta| json!({
            "address": meta.pubkey.to_string(),
            "signer": meta.is_signer,
            "writable": meta.is_writable,
        })).collect::<Vec<_>>(),
    });
    let bridge = Command::new("node_modules/.bin/bun")
        .args([
            "scripts/live-queue/generated-client.ts",
            &request.to_string(),
        ])
        .output()
        .expect("generated client bridge; run npm ci first");
    assert!(
        bridge.status.success(),
        "Generated client failed: {}",
        String::from_utf8_lossy(&bridge.stderr)
    );
    let plan: GeneratedPlan =
        serde_json::from_slice(&bridge.stdout).expect("generated client JSON");
    let data = STANDARD
        .decode(plan.data)
        .expect("generated client instruction base64");
    assert_eq!(data.len(), 68, "queue interface instruction size changed");
    let accounts = plan
        .accounts
        .into_iter()
        .map(|meta| {
            let address = meta
                .address
                .parse()
                .expect("generated client account address");
            AccountMeta {
                pubkey: address,
                is_signer: meta.signer,
                is_writable: meta.writable,
            }
        })
        .collect();
    Instruction {
        program_id: program,
        accounts,
        data,
    }
}
fn main() {
    let cli = parse_args(std::env::args().skip(1)).unwrap_or_else(|error| panic!("{error}"));
    let mut rpc = Rpc {
        url: cli.url,
        receipts: vec![],
        receipt_path: None,
    };
    let version = rpc.call("getVersion", json!([]));
    let genesis = rpc.call("getGenesisHash", json!([]));
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let dir = std::path::PathBuf::from(format!("build/live-queue-{stamp}"));
    fs::create_dir(&dir).unwrap();
    rpc.receipt_path = Some(dir.join("receipts.json"));
    rpc.flush_receipts();
    let stem = cli.program.clone();
    let elf_path = format!("{stem}.so");
    // Instruction plans come from build/queue.client.js; the client is
    // target-independent, so another build stem must carry the same bytes.
    for suffix in ["client.js", "interface.json"] {
        assert_eq!(
            fs::read(format!("{stem}.{suffix}")).unwrap(),
            fs::read(format!("{DEFAULT_PROGRAM}.{suffix}")).unwrap(),
            "{stem}.{suffix} differs from {DEFAULT_PROGRAM}.{suffix}"
        );
    }
    fs::copy(format!("{stem}.manifest.json"), dir.join("build.manifest.json")).unwrap();
    let fresh_payer = Keypair::new();
    let program = Keypair::new();
    let state = Keypair::new();
    let collection = Keypair::new();
    save_key(&dir, "program.json", &program);
    let (payer, payer_key_path, funding_mode) = match cli.payer {
        Some(path) => {
            let payer = load_supplied_payer(&path).unwrap_or_else(|error| panic!("{error}"));
            (payer, path, "supplied-payer")
        }
        None => {
            let path = dir.join("payer.json");
            save_key(&dir, "payer.json", &fresh_payer);
            let sig = rpc.call(
                "requestAirdrop",
                json!([fresh_payer.pubkey().to_string(),2_000_000_000u64,{"commitment":"confirmed"}]),
            );
            let sig = sig.as_str().unwrap();
            rpc.receipts.push(json!({
                "label": "test SOL airdrop",
                "signature": sig,
                "outcome": "pending",
                "note": "faucet signature returned by RPC; no locally signed transaction exists",
            }));
            rpc.flush_receipts();
            rpc.confirm("test SOL airdrop", sig, Value::Null);
            (fresh_payer, path, "fresh-airdrop")
        }
    };
    let payer_starting_lamports = rpc.lamports(payer.pubkey());
    if payer_starting_lamports == 0 {
        rpc.failure(
            "getBalance",
            json!({
                "kind": "insufficient-funds",
                "payer": payer.pubkey().to_string(),
                "balanceLamports": payer_starting_lamports,
                "requiredLamports": 1,
                "shortfallLamports": 1,
            }),
        );
        panic!(
            "Payer {} has 0 lamports; need at least 1 lamport and will not use another wallet",
            payer.pubkey()
        );
    }
    println!(
        "Payer: {} (funding: {funding_mode}, starting balance: {payer_starting_lamports} lamports)",
        payer.pubkey()
    );
    let deployment = Command::new("solana")
        .args([
            "--url",
            &rpc.url,
            "--keypair",
            payer_key_path.to_str().unwrap(),
            "--commitment",
            "confirmed",
            "program",
            "deploy",
            "--use-rpc",
            &elf_path,
            "--program-id",
            dir.join("program.json").to_str().unwrap(),
            "--output",
            "json",
        ])
        .output()
        .unwrap();
    fs::write(dir.join("deployment.stdout"), &deployment.stdout).unwrap();
    fs::write(dir.join("deployment.stderr"), &deployment.stderr).unwrap();
    if !deployment.status.success() {
        write_deployment_uncertainty(&dir, program.pubkey(), &deployment);
        panic!(
            "Deployment failed; inspect {}/deployment-uncertain.json and deployment stdout/stderr before retrying",
            dir.display()
        );
    }
    let deployment_sig = deployment_signature(&deployment.stdout);
    assert_eq!(rpc.account(program.pubkey())["executable"], true);
    // Dump the deployed program and compare every ELF byte, including any zero padding.
    let dumped = dir.join("deployed.so");
    assert!(Command::new("solana")
        .args([
            "--url",
            &rpc.url,
            "--commitment",
            "confirmed",
            "program",
            "dump",
            &program.pubkey().to_string(),
            dumped.to_str().unwrap()
        ])
        .status()
        .unwrap()
        .success());
    let elf = fs::read(&elf_path).unwrap();
    let actual = fs::read(&dumped).unwrap();
    assert!(
        actual.starts_with(&elf) && actual[elf.len()..].iter().all(|b| *b == 0),
        "Deployed bytes differ"
    );
    let mint = Keypair::new();
    let source = Keypair::new();
    let vault = Keypair::new();
    let destinations = [Keypair::new(), Keypair::new()];
    let owners = [Pubkey::new_unique(), Pubkey::new_unique()];
    let (custody, _) =
        Pubkey::find_program_address(&[b"bend", state.pubkey().as_ref()], &program.pubkey());
    rpc.send(
        "create mint",
        &payer,
        &[&mint],
        &[
            rpc.create(payer.pubkey(), mint.pubkey(), Mint::LEN, spl_token::id()),
            token::initialize_mint2(
                &spl_token::id(),
                &mint.pubkey(),
                &payer.pubkey(),
                Some(&payer.pubkey()),
                6,
            )
            .unwrap(),
        ],
        Value::Null,
    );
    for (label, key, owner) in [
        ("source", &source, payer.pubkey()),
        ("vault", &vault, custody),
        ("recipient 0", &destinations[0], owners[0]),
        ("recipient 1", &destinations[1], owners[1]),
    ] {
        rpc.send(
            label,
            &payer,
            &[key],
            &[
                rpc.create(
                    payer.pubkey(),
                    key.pubkey(),
                    TokenAccount::LEN,
                    spl_token::id(),
                ),
                token::initialize_account3(&spl_token::id(), &key.pubkey(), &mint.pubkey(), &owner)
                    .unwrap(),
            ],
            Value::Null,
        );
    }
    rpc.send(
        "mint test tokens",
        &payer,
        &[],
        &[token::mint_to(
            &spl_token::id(),
            &mint.pubkey(),
            &source.pubkey(),
            &payer.pubkey(),
            &[],
            1000,
        )
        .unwrap()],
        Value::Null,
    );
    let interface: Value =
        serde_json::from_slice(&fs::read(format!("{stem}.interface.json")).unwrap()).unwrap();
    assert_eq!(interface["instructionBytes"], 68);
    assert_eq!(interface["collection"]["stride"], 43);
    let state_size = interface["stateBytes"].as_u64().unwrap() as usize;
    let ix = |instruction, args, mode, remaining| {
        queue_ix(
            program.pubkey(),
            state.pubkey(),
            payer.pubkey(),
            custody,
            collection.pubkey(),
            instruction,
            args,
            mode,
            remaining,
        )
    };
    rpc.send(
        "initialize large collection",
        &payer,
        &[&state, &collection],
        &[
            rpc.create(payer.pubkey(), state.pubkey(), state_size, program.pubkey()),
            rpc.create(
                payer.pubkey(),
                collection.pubkey(),
                56 + 43 * 256,
                program.pubkey(),
            ),
            ix(
                "Initialize",
                json!({"mint":mint.pubkey().to_string(),"vault":vault.pubkey().to_string()}),
                "initialize",
                vec![],
            ),
        ],
        Value::Null,
    );
    for (recipient, amount) in [(0, 17u64), (1, 18), (0, 19)] {
        rpc.send(
            "fund obligation",
            &payer,
            &[],
            &[ix(
                "Append",
                json!({"recipient":owners[recipient].to_string(),"amount":amount.to_string()}),
                "transition",
                vec![
                    AccountMeta::new(source.pubkey(), false),
                    AccountMeta::new(vault.pubkey(), false),
                    AccountMeta::new_readonly(mint.pubkey(), false),
                ],
            )],
            Value::Null,
        );
    }
    assert_eq!(
        (rpc.balance(source.pubkey()), rpc.balance(vault.pubkey())),
        (946, 54)
    );
    let records = rpc.bytes(collection.pubkey());
    assert_eq!(records.len(), 11064);
    assert_eq!(u32::from_le_bytes(records[20..24].try_into().unwrap()), 3);
    rpc.send(
        "seal",
        &payer,
        &[],
        &[ix("Seal", json!({}), "transition", vec![])],
        Value::Null,
    );
    let settle = |start: usize, count: u32| {
        let mut metas = vec![
            AccountMeta::new(vault.pubkey(), false),
            AccountMeta::new_readonly(mint.pubkey(), false),
        ];
        for i in 0..count as usize {
            metas.push(AccountMeta::new(
                destinations[(start + i) % 2].pubkey(),
                false,
            ));
        }
        ix(
            "Settle",
            json!({"count":count,"fuel":count}),
            "transition",
            metas,
        )
    };
    rpc.send(
        "freeze second recipient",
        &payer,
        &[],
        &[token::freeze_account(
            &spl_token::id(),
            &destinations[1].pubkey(),
            &mint.pubkey(),
            &payer.pubkey(),
            &[],
        )
        .unwrap()],
        Value::Null,
    );
    let managed = [
        state.pubkey(),
        collection.pubkey(),
        source.pubkey(),
        vault.pubkey(),
        destinations[0].pubkey(),
        destinations[1].pubkey(),
    ];
    let snapshot = managed.map(|k| rpc.account(k));
    rpc.send(
        "late token failure",
        &payer,
        &[],
        &[settle(0, 2)],
        json!({"InstructionError":[0,{"Custom":17}]}),
    );
    assert_eq!(
        managed.map(|k| rpc.account(k)),
        snapshot,
        "Failure must roll back all application accounts"
    );
    rpc.send(
        "thaw second recipient",
        &payer,
        &[],
        &[token::thaw_account(
            &spl_token::id(),
            &destinations[1].pubkey(),
            &mint.pubkey(),
            &payer.pubkey(),
            &[],
        )
        .unwrap()],
        Value::Null,
    );
    rpc.send("settle page 1", &payer, &[], &[settle(0, 2)], Value::Null);
    assert_eq!(
        (
            rpc.balance(destinations[0].pubkey()),
            rpc.balance(destinations[1].pubkey()),
            rpc.balance(vault.pubkey())
        ),
        (17, 18, 19)
    );
    let progress = rpc.bytes(state.pubkey());
    assert_eq!(progress[20], 2);
    assert_eq!(
        u32::from_le_bytes(progress[158..162].try_into().unwrap()),
        2
    );
    rpc.send("settle page 2", &payer, &[], &[settle(2, 1)], Value::Null);
    assert_eq!(rpc.bytes(state.pubkey())[20], 3);
    assert_eq!(rpc.bytes(collection.pubkey()), records);
    assert_eq!(
        (
            rpc.balance(destinations[0].pubkey()),
            rpc.balance(destinations[1].pubkey()),
            rpc.balance(vault.pubkey())
        ),
        (36, 18, 0)
    );
    let snapshot = managed.map(|k| rpc.account(k));
    rpc.send(
        "replay rejected",
        &payer,
        &[],
        &[settle(0, 1)],
        json!({"InstructionError":[0,{"Custom":258}]}),
    );
    assert_eq!(managed.map(|k| rpc.account(k)), snapshot);
    let payer_final_lamports = rpc.lamports(payer.pubkey());
    let report = json!({"passed":true,"rpc":rpc.url,"version":version,"genesisHash":genesis,"program":program.pubkey().to_string(),
        "payer":{"address":payer.pubkey().to_string(),"fundingMode":funding_mode,"startingLamports":payer_starting_lamports,"finalLamports":payer_final_lamports,"finalSol":(payer_final_lamports as f64)/1_000_000_000.0},
        "deployment":{"signature":deployment_sig,"stdout":"deployment.stdout","stderr":"deployment.stderr"},
        "generatedClient":"build/queue.client.js","generatedClientBridge":"scripts/live-queue/generated-client.ts",
        "state":state.pubkey().to_string(),"collection":collection.pubkey().to_string(),"collectionBytes":11064,
        "programElf":elf_path,"elfBytesMatched":elf.len(),"recipientBalances":[36,18],"custodyBalance":0,"receipts":rpc.receipts});
    fs::write(
        dir.join("report.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!(
        "Live queue validation passed: {}",
        dir.join("report.json").display()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_two_test_endpoints() {
        assert_eq!(
            parse_args([DEVNET_URL]),
            Ok(Cli {
                url: DEVNET_URL.into(),
                payer: None,
                program: DEFAULT_PROGRAM.into(),
            })
        );
        assert_eq!(
            parse_args([LOCAL_URL, "--payer", "build/test-payer.json"]),
            Ok(Cli {
                url: LOCAL_URL.into(),
                payer: Some("build/test-payer.json".into()),
                program: DEFAULT_PROGRAM.into(),
            })
        );
        assert_eq!(
            parse_args([LOCAL_URL, "--program", "build/v3/queue"]),
            Ok(Cli {
                url: LOCAL_URL.into(),
                payer: None,
                program: "build/v3/queue".into(),
            })
        );
        assert!(parse_args(["https://api.mainnet-beta.solana.com"]).is_err());
        assert!(parse_args(["http://127.0.0.1:8899"]).is_err());
    }

    #[test]
    fn validates_payer_option_shape() {
        assert!(parse_args([DEVNET_URL, "--payer"]).is_err());
        assert!(parse_args([DEVNET_URL, "--payer", "--unknown"]).is_err());
        assert!(parse_args([DEVNET_URL, "--payer=--unknown"]).is_err());
        assert!(parse_args([DEVNET_URL, "--payer="]).is_err());
        assert!(parse_args([DEVNET_URL, "--payer", "a", "--payer", "b"]).is_err());
        assert!(parse_args([DEVNET_URL, "--unknown"]).is_err());
        assert!(parse_args([DEVNET_URL, "--program"]).is_err());
        assert!(parse_args([DEVNET_URL, "--program="]).is_err());
        assert!(parse_args([DEVNET_URL, "--program", "--payer"]).is_err());
        assert!(parse_args([DEVNET_URL, "--program", "a", "--program=b"]).is_err());
        assert!(parse_args([DEVNET_URL, LOCAL_URL]).is_err());
        assert!(parse_args(std::iter::empty::<String>()).is_err());
    }

    #[test]
    fn finds_public_deployment_signature_without_logging_key_material() {
        assert_eq!(
            deployment_signature(br#"{"result":{"signature":"abc"}}"#),
            Some("abc".into())
        );
        assert_eq!(deployment_signature(br#"not json"#), None);
    }
}
