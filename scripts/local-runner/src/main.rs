//! Generic JSON-lines transport for Bend's local RPC test context.
//! This runner accepts only the project's isolated loopback validator.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_system_interface::instruction as system;
use solana_transaction::Transaction;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions, Permissions},
    io::{self, BufRead, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const LOCAL_URL: &str = "http://127.0.0.1:18899";
const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
type Result<T> = std::result::Result<T, String>;

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("Missing string {key}"))
}
fn pubkey(value: &Value, key: &str) -> Result<Pubkey> {
    text(value, key)?
        .parse()
        .map_err(|_| format!("Invalid address {key}"))
}
fn list<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>> {
    value[key]
        .as_array()
        .ok_or_else(|| format!("Missing array {key}"))
}
fn instruction(value: &Value) -> Result<Instruction> {
    let accounts = list(value, "accounts")?
        .iter()
        .map(|account| {
            Ok(AccountMeta {
                pubkey: pubkey(account, "address")?,
                is_signer: account["signer"].as_bool().ok_or("Missing signer flag")?,
                is_writable: account["writable"]
                    .as_bool()
                    .ok_or("Missing writable flag")?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let data = serde_json::from_value(value["data"].clone())
        .map_err(|_| "Instruction bytes must be u8[]")?;
    Ok(Instruction {
        program_id: pubkey(value, "program")?,
        accounts,
        data,
    })
}
fn code_from_error(error: &Value) -> Option<u32> {
    error
        .get("InstructionError")?
        .as_array()?
        .get(1)?
        .get("Custom")?
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
}
fn write_private(path: &Path, contents: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("Cannot write {}: {e}", path.display()))?;
    file.set_permissions(Permissions::from_mode(0o600))
        .map_err(|e| format!("Cannot protect {}: {e}", path.display()))?;
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("Cannot flush {}: {e}", path.display()))
}
fn append_private(path: &Path, contents: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("Cannot append {}: {e}", path.display()))?;
    file.set_permissions(Permissions::from_mode(0o600))
        .map_err(|e| format!("Cannot protect {}: {e}", path.display()))?;
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("Cannot append {}: {e}", path.display()))
}
fn write_json(path: &Path, value: &Value) -> Result<()> {
    write_private(
        path,
        &serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
}
fn save_key(path: &Path, key: &Keypair) -> Result<()> {
    write_private(
        path,
        serde_json::to_string(&key.to_bytes().to_vec())
            .unwrap()
            .as_bytes(),
    )
}
fn relative_to_cwd(path: &Path) -> String {
    let cwd = std::env::current_dir().unwrap_or_default();
    path.strip_prefix(&cwd)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[derive(Debug)]
struct HttpResponse {
    status: u16,
    body: Vec<u8>,
}
fn decode_chunked(mut input: &[u8]) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    loop {
        let line_end = input
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or("Malformed chunked HTTP response")?;
        let size =
            std::str::from_utf8(&input[..line_end]).map_err(|_| "Malformed HTTP chunk size")?;
        let size = usize::from_str_radix(size.split(';').next().unwrap_or(size), 16)
            .map_err(|_| "Malformed HTTP chunk size")?;
        input = &input[line_end + 2..];
        if size == 0 {
            return Ok(output);
        }
        if input.len() < size + 2 || &input[size..size + 2] != b"\r\n" {
            return Err("Truncated HTTP chunk".into());
        }
        output.extend_from_slice(&input[..size]);
        input = &input[size + 2..];
        if output.len() > 64 * 1024 * 1024 {
            return Err("RPC response exceeded 64 MiB".into());
        }
    }
}
fn http_post(url: &str, body: &[u8]) -> Result<HttpResponse> {
    if url != LOCAL_URL {
        return Err("Only http://127.0.0.1:18899 is allowed".into());
    }
    let authority = url
        .strip_prefix("http://")
        .ok_or("RPC must use HTTP on the explicit local endpoint")?;
    let address = authority
        .to_socket_addrs()
        .map_err(|e| format!("Invalid RPC endpoint: {e}"))?
        .next()
        .ok_or("RPC endpoint did not resolve")?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(10))
        .map_err(|e| format!("Cannot connect to local validator: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    write!(stream, "POST / HTTP/1.1\r\nHost: 127.0.0.1:18899\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", body.len())
        .and_then(|_| stream.write_all(body)).map_err(|e| format!("Cannot send local RPC request: {e}"))?;
    let mut response = Vec::new();
    stream
        .take(64 * 1024 * 1024 + 64 * 1024)
        .read_to_end(&mut response)
        .map_err(|e| format!("Local RPC response timed out or failed: {e}"))?;
    let split = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("Malformed HTTP response headers")?;
    let headers = String::from_utf8_lossy(&response[..split]).into_owned();
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse().ok())
        .ok_or("Malformed HTTP status line")?;
    let raw_body = &response[split + 4..];
    let chunked = headers.lines().any(|line| {
        line.to_ascii_lowercase().starts_with("transfer-encoding:")
            && line.to_ascii_lowercase().contains("chunked")
    });
    let body = if chunked {
        decode_chunked(raw_body)?
    } else {
        raw_body.to_vec()
    };
    Ok(HttpResponse { status, body })
}

struct Rpc {
    url: String,
    receipts_path: PathBuf,
    receipts: Vec<Value>,
}
impl Rpc {
    fn flush(&self) -> Result<()> {
        write_json(
            &self.receipts_path,
            &json!({"rpc":self.url,"receipts":self.receipts}),
        )
    }
    fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body = json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string();
        let response = http_post(&self.url, body.as_bytes())?;
        if !(200..300).contains(&response.status) {
            return Err(format!(
                "RPC {method} HTTP {}: {}",
                response.status,
                String::from_utf8_lossy(&response.body)
            ));
        }
        let parsed: Value = serde_json::from_slice(&response.body)
            .map_err(|e| format!("RPC {method} returned invalid JSON: {e}"))?;
        if !parsed["error"].is_null() {
            return Err(format!("RPC {method}: {}", parsed["error"]));
        }
        parsed
            .get("result")
            .cloned()
            .ok_or_else(|| format!("RPC {method} response has no result"))
    }
    fn record(&mut self, label: &str, signature: &str, outcome: &str, note: &str) -> Result<()> {
        self.receipts
            .push(json!({"label":label,"signature":signature,"outcome":outcome,"note":note}));
        self.flush()
    }
    fn update(&mut self, signature: &str, fields: Value) -> Result<()> {
        let receipt = self
            .receipts
            .iter_mut()
            .rev()
            .find(|receipt| receipt["signature"] == signature)
            .ok_or("Missing transaction receipt")?;
        if let (Some(dst), Some(src)) = (receipt.as_object_mut(), fields.as_object()) {
            for (key, value) in src {
                dst.insert(key.clone(), value.clone());
            }
        }
        self.flush()
    }
    fn uncertain(&mut self, signature: &str, reason: &str) -> Result<()> {
        self.update(signature, json!({"outcome":"uncertain","reason":reason}))
    }
    fn confirm(
        &mut self,
        label: &str,
        signature: &str,
        expected_error: Option<Value>,
    ) -> Result<Value> {
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut status_failures = 0;
        loop {
            if Instant::now() >= deadline {
                self.uncertain(
                    signature,
                    "Confirmation timed out; inspect getSignatureStatuses before retrying",
                )?;
                return Err(format!(
                    "Confirmation timed out for {signature}; do not resubmit this transaction"
                ));
            }
            let result = match self.call(
                "getSignatureStatuses",
                json!([[signature],{"searchTransactionHistory":true}]),
            ) {
                Ok(result) => {
                    status_failures = 0;
                    result
                }
                Err(error) => {
                    status_failures += 1;
                    if status_failures >= 6 {
                        self.uncertain(signature, "Status lookup failed after submission; inspect the signature before retrying")?;
                        return Err(format!(
                            "Status lookup failed for {signature}; do not resubmit: {error}"
                        ));
                    }
                    thread::sleep(Duration::from_millis(500));
                    continue;
                }
            };
            let status = &result["value"][0];
            if matches!(
                status["confirmationStatus"].as_str(),
                Some("confirmed" | "finalized")
            ) {
                let status_error = status["err"].clone();
                let matching_error = expected_error
                    .as_ref()
                    .map(|error| *error == status_error)
                    .unwrap_or(true);
                if !matching_error {
                    self.update(
                        signature,
                        json!({"outcome":"unexpected-status","status":status}),
                    )?;
                    return Err(format!("{label}: unexpected transaction status {}", status));
                }
                self.update(signature, json!({"outcome":"confirmed","status":status}))?;
                return Ok(status.clone());
            }
            thread::sleep(Duration::from_millis(500));
        }
    }
    fn account(&self, address: Pubkey) -> Result<Option<Value>> {
        let result = self.call(
            "getAccountInfo",
            json!([address.to_string(),{"encoding":"base64","commitment":"confirmed"}]),
        )?;
        let value = result.get("value").cloned().unwrap_or(Value::Null);
        if value.is_null() {
            return Ok(None);
        }
        let bytes = STANDARD
            .decode(
                value["data"][0]
                    .as_str()
                    .ok_or("Account data is not base64")?,
            )
            .map_err(|e| format!("Invalid base64 account data: {e}"))?;
        Ok(Some(
            json!({"lamports":value["lamports"],"owner":value["owner"],"executable":value["executable"],"data":bytes}),
        ))
    }
    fn transaction(&self, signature: &str) -> Result<Value> {
        self.call("getTransaction", json!([signature,{"encoding":"json","commitment":"confirmed","maxSupportedTransactionVersion":0}]))
    }
    fn rent(&self, bytes: usize) -> Result<u64> {
        self.call(
            "getMinimumBalanceForRentExemption",
            json!([bytes,{"commitment":"confirmed"}]),
        )?
        .as_u64()
        .ok_or_else(|| "Invalid rent exemption RPC response".into())
    }
}

struct CommandResult {
    status: Option<i32>,
    timed_out: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}
fn run_command(command: &mut Command, timeout: Duration) -> Result<CommandResult> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "Cannot start {}: {e}",
                command.get_program().to_string_lossy()
            )
        })?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = io::Read::read_to_end(&mut stdout, &mut bytes);
        bytes
    });
    let err_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = io::Read::read_to_end(&mut stderr, &mut bytes);
        bytes
    });
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child
            .try_wait()
            .map_err(|e| format!("Cannot wait for command: {e}"))?
        {
            Some(status) => break Some(status.code().unwrap_or(-1)),
            None if Instant::now() >= deadline => {
                timed_out = true;
                let _ = child.kill();
                let status = child.wait().ok();
                break status.map(|s| s.code().unwrap_or(-1));
            }
            None => thread::sleep(Duration::from_millis(100)),
        }
    };
    Ok(CommandResult {
        status,
        timed_out,
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    })
}
fn run_command_to_files(
    command: &mut Command,
    timeout: Duration,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<CommandResult> {
    let stdout = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(stdout_path)
        .map_err(|e| format!("Cannot open {}: {e}", stdout_path.display()))?;
    let stderr = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(stderr_path)
        .map_err(|e| format!("Cannot open {}: {e}", stderr_path.display()))?;
    let mut child = command
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|e| {
            format!(
                "Cannot start {}: {e}",
                command.get_program().to_string_lossy()
            )
        })?;
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child
            .try_wait()
            .map_err(|e| format!("Cannot wait for command: {e}"))?
        {
            Some(status) => break Some(status.code().unwrap_or(-1)),
            None if Instant::now() >= deadline => {
                timed_out = true;
                let _ = child.kill();
                let status = child.wait().ok();
                break status.map(|s| s.code().unwrap_or(-1));
            }
            None => thread::sleep(Duration::from_millis(100)),
        }
    };
    Ok(CommandResult {
        status,
        timed_out,
        stdout: fs::read(stdout_path)
            .map_err(|e| format!("Cannot read {}: {e}", stdout_path.display()))?,
        stderr: fs::read(stderr_path)
            .map_err(|e| format!("Cannot read {}: {e}", stderr_path.display()))?,
    })
}
fn deploy_command(
    endpoint: &str,
    payer_path: &Path,
    elf_path: &Path,
    program_path: &Path,
) -> Command {
    let mut command = Command::new("solana");
    command
        .args(["--url", endpoint, "--keypair"])
        .arg(payer_path)
        .args([
            "--commitment",
            "confirmed",
            "program",
            "deploy",
            "--use-rpc",
            "--max-sign-attempts",
            "1",
        ])
        .arg(elf_path)
        .arg("--program-id")
        .arg(program_path)
        .args(["--output", "json"]);
    command
}
fn find_signatures(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if let Some(signature) = object.get("signature").and_then(Value::as_str) {
                out.push(signature.to_owned());
            }
            for child in object.values() {
                find_signatures(child, out);
            }
        }
        Value::Array(values) => {
            for child in values {
                find_signatures(child, out);
            }
        }
        _ => {}
    }
}
fn deployment_signatures(bytes: &[u8]) -> Vec<String> {
    let mut signatures = Vec::new();
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        find_signatures(&value, &mut signatures);
    }
    signatures.sort();
    signatures.dedup();
    signatures
}
fn deployment_uncertain(
    dir: &Path,
    program: Pubkey,
    signatures: &[String],
    reason: &str,
    exit_code: Option<i32>,
    timed_out: bool,
) -> Result<()> {
    write_json(
        &dir.join("deployment-uncertain.json"),
        &json!({
            "outcome":"uncertain","reason":reason,"program":program.to_string(),
            "signatures":signatures,"exitCode":exit_code,"timedOut":timed_out,
            "stdoutPath":"deployment.stdout","stderrPath":"deployment.stderr"
        }),
    )
}
fn extract_error(value: &Value) -> Option<u32> {
    code_from_error(value)
}
fn fresh_blockhash(
    previous: Option<&str>,
    mut latest: impl FnMut() -> Result<String>,
) -> Result<String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let blockhash = latest()?;
        if previous != Some(blockhash.as_str()) {
            return Ok(blockhash);
        }
        if Instant::now() >= deadline {
            return Err(
                "Local validator did not produce a fresh blockhash within 30 seconds".into(),
            );
        }
        thread::sleep(Duration::from_millis(250));
    }
}

struct Runner {
    dir: PathBuf,
    rpc: Rpc,
    payer: Keypair,
    program: Keypair,
    keys_by_name: HashMap<String, Pubkey>,
    keys: HashMap<Pubkey, Keypair>,
    next_key: u32,
    last_test_blockhash: Option<String>,
    hello: Value,
}
impl Runner {
    fn new(endpoint: String, elf_path: PathBuf, dir: PathBuf) -> Result<Self> {
        if endpoint != LOCAL_URL {
            return Err("Only explicit local endpoint http://127.0.0.1:18899 is supported".into());
        }
        let current = std::env::current_dir().map_err(|e| e.to_string())?;
        let build = current
            .join("build")
            .canonicalize()
            .map_err(|e| format!("Missing ignored build directory: {e}"))?;
        if !dir.is_dir() {
            return Err("Local run directory must be created by the project CLI".into());
        }
        let dir = dir.canonicalize().map_err(|e| e.to_string())?;
        if !dir.starts_with(&build) {
            return Err("Local run directory must stay under ignored build/".into());
        }
        fs::set_permissions(&dir, Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        if !elf_path.is_file() {
            return Err(format!("Missing built ELF {}", elf_path.display()));
        }
        let receipts_path = dir.join("receipts.json");
        let mut rpc = Rpc {
            url: endpoint.clone(),
            receipts_path,
            receipts: vec![],
        };
        rpc.flush()?;
        let payer = Keypair::new();
        let program = Keypair::new();
        save_key(&dir.join("payer.json"), &payer)?;
        save_key(&dir.join("program.json"), &program)?;
        let version = rpc.call("getVersion", json!([]))?;
        let genesis_hash = rpc
            .call("getGenesisHash", json!([]))?
            .as_str()
            .ok_or("Invalid genesis hash")?
            .to_owned();
        let payer_balance = rpc
            .call(
                "requestAirdrop",
                json!([payer.pubkey().to_string(),10*LAMPORTS_PER_SOL,{"commitment":"confirmed"}]),
            )?
            .as_str()
            .ok_or("Invalid airdrop response")?
            .to_owned();
        rpc.record(
            "fresh local test payer airdrop",
            &payer_balance,
            "pending",
            "Airdrop signature returned by the explicit local validator",
        )?;
        rpc.confirm(
            "fresh local test payer airdrop",
            &payer_balance,
            Some(Value::Null),
        )?;
        let cli_version = run_command(
            Command::new("solana").arg("--version"),
            Duration::from_secs(15),
        )?;
        if cli_version.status != Some(0) || cli_version.timed_out {
            return Err(format!(
                "solana --version failed: {}",
                String::from_utf8_lossy(&cli_version.stderr)
            ));
        }
        let deployment_stdout = dir.join("deployment.stdout");
        let deployment_stderr = dir.join("deployment.stderr");
        write_private(&deployment_stdout, b"")?;
        write_private(&deployment_stderr, b"")?;
        deployment_uncertain(
            &dir,
            program.pubkey(),
            &[],
            "solana program deploy is starting or was interrupted; inspect saved output and chain state before retrying",
            None,
            false,
        )?;
        let deployment = match run_command_to_files(
            &mut deploy_command(
                &endpoint,
                &dir.join("payer.json"),
                &elf_path,
                &dir.join("program.json"),
            ),
            Duration::from_secs(300),
            &deployment_stdout,
            &deployment_stderr,
        ) {
            Ok(output) => output,
            Err(error) => {
                append_private(&deployment_stderr, format!("{error}\n").as_bytes())?;
                deployment_uncertain(
                    &dir,
                    program.pubkey(),
                    &[],
                    "solana program deploy could not start or did not return a complete result; inspect saved output and chain state before retrying",
                    None,
                    false,
                )?;
                return Err(format!(
                    "solana program deploy did not return a complete result; inspect {}/deployment-uncertain.json",
                    relative_to_cwd(&dir)
                ));
            }
        };
        let mut signatures = deployment_signatures(&deployment.stdout)
            .into_iter()
            .chain(deployment_signatures(&deployment.stderr))
            .collect::<Vec<_>>();
        signatures.sort();
        signatures.dedup();
        if deployment.timed_out || deployment.status != Some(0) || signatures.is_empty() {
            deployment_uncertain(
                &dir,
                program.pubkey(),
                &signatures,
                "solana program deploy failed or returned no parseable signature; inspect saved output and status before retrying",
                deployment.status,
                deployment.timed_out,
            )?;
            return Err(format!("solana program deploy did not complete cleanly; inspect {}/deployment-uncertain.json",relative_to_cwd(&dir)));
        }
        let ordered_signatures = signatures;
        for signature in &ordered_signatures {
            rpc.record(
                "program deployment",
                signature,
                "pending",
                "Signature reported by solana program deploy; inspect before any retry",
            )?;
            if let Err(error) = rpc.confirm("program deployment", signature, Some(Value::Null)) {
                deployment_uncertain(
                    &dir,
                    program.pubkey(),
                    &ordered_signatures,
                    &format!("deployment signature confirmation is uncertain: {error}"),
                    deployment.status,
                    deployment.timed_out,
                )?;
                return Err(format!("Deployment signature confirmation is uncertain; inspect {}/deployment-uncertain.json",relative_to_cwd(&dir)));
            }
        }
        let account = match rpc.call(
            "getAccountInfo",
            json!([program.pubkey().to_string(),{"encoding":"base64","commitment":"confirmed"}]),
        ) {
            Ok(account) => account,
            Err(error) => {
                deployment_uncertain(
                    &dir,
                    program.pubkey(),
                    &ordered_signatures,
                    &format!("cannot verify deployed program account: {error}"),
                    deployment.status,
                    deployment.timed_out,
                )?;
                return Err(format!(
                    "Cannot verify deployed program account; inspect {}/deployment-uncertain.json",
                    relative_to_cwd(&dir)
                ));
            }
        };
        if account["value"]["executable"] != true {
            deployment_uncertain(
                &dir,
                program.pubkey(),
                &ordered_signatures,
                "deployed program account is not executable",
                deployment.status,
                deployment.timed_out,
            )?;
            return Err("Deployed program account is not executable".into());
        }
        let dumped = dir.join("deployed.so");
        let dump = match run_command(
            Command::new("solana").args([
                "--url",
                endpoint.as_str(),
                "--commitment",
                "confirmed",
                "program",
                "dump",
                &program.pubkey().to_string(),
                dumped.to_str().ok_or("Invalid deployed ELF path")?,
            ]),
            Duration::from_secs(120),
        ) {
            Ok(dump) => dump,
            Err(error) => {
                write_private(&dir.join("dump.stdout"), b"")?;
                write_private(&dir.join("dump.stderr"), error.as_bytes())?;
                deployment_uncertain(
                    &dir,
                    program.pubkey(),
                    &ordered_signatures,
                    &format!("cannot dump deployed program: {error}"),
                    deployment.status,
                    deployment.timed_out,
                )?;
                return Err(format!(
                    "Cannot dump deployed program; inspect {}/deployment-uncertain.json",
                    relative_to_cwd(&dir)
                ));
            }
        };
        write_private(&dir.join("dump.stdout"), &dump.stdout)?;
        write_private(&dir.join("dump.stderr"), &dump.stderr)?;
        if dump.status != Some(0) || dump.timed_out {
            deployment_uncertain(
                &dir,
                program.pubkey(),
                &ordered_signatures,
                "solana program dump failed; inspect saved dump output",
                dump.status,
                dump.timed_out,
            )?;
            return Err(format!(
                "solana program dump failed: {}",
                String::from_utf8_lossy(&dump.stderr)
            ));
        }
        let expected = fs::read(&elf_path).map_err(|e| format!("Cannot read built ELF: {e}"))?;
        let actual = fs::read(&dumped).map_err(|e| format!("Cannot read deployed ELF: {e}"))?;
        let zero_padding_bytes = actual.len().saturating_sub(expected.len());
        if !actual.starts_with(&expected) || actual[expected.len()..].iter().any(|byte| *byte != 0)
        {
            deployment_uncertain(
                &dir,
                program.pubkey(),
                &ordered_signatures,
                "deployed program bytes do not match the ELF; inspect output and account state",
                deployment.status,
                deployment.timed_out,
            )?;
            return Err("Deployed executable bytes do not match the built ELF (zero padding is the only allowed suffix)".into());
        }
        let solana_version = String::from_utf8_lossy(&cli_version.stdout)
            .trim()
            .to_owned();
        let local_evidence = json!({
            "endpoint":endpoint.clone(),"runtime":format!("{} ({})",version["solana-core"].as_str().unwrap_or("Solana RPC"),solana_version),
            "version":version,"genesisHash":genesis_hash,"directory":relative_to_cwd(&dir),
            "receiptsPath":relative_to_cwd(&rpc.receipts_path),"program":program.pubkey().to_string(),
            "deploymentSignature":ordered_signatures.last().cloned(),"elfBytesMatched":expected.len(),
            "elfBytes":actual.len(),"zeroPaddingBytes":zero_padding_bytes
        });
        let payer_address = payer.pubkey().to_string();
        let program_address = program.pubkey().to_string();
        let hello = json!({
            "payer":payer_address,"program":program_address,"backend":"local-rpc",
            "runtime":local_evidence["runtime"],"localEvidence":local_evidence
        });
        fs::remove_file(dir.join("deployment-uncertain.json"))
            .map_err(|e| format!("Cannot clear completed deployment uncertainty marker: {e}"))?;
        Ok(Self {
            dir,
            rpc,
            payer,
            program,
            keys_by_name: HashMap::new(),
            keys: HashMap::new(),
            next_key: 1,
            last_test_blockhash: None,
            hello,
        })
    }
    fn save_named_keys(&self) -> Result<()> {
        let map = self
            .keys_by_name
            .iter()
            .map(|(name, key)| (name.clone(), json!(key.to_string())))
            .collect::<serde_json::Map<_, _>>();
        write_json(&self.dir.join("named-keys.json"), &Value::Object(map))
    }
    fn send(&mut self, instructions: &[Instruction]) -> Result<Value> {
        if instructions.is_empty() {
            return Err("Expected at least one instruction".into());
        }
        let mut seen = HashSet::new();
        let mut signers = vec![&self.payer];
        seen.insert(self.payer.pubkey());
        for ix in instructions {
            for meta in &ix.accounts {
                if meta.is_signer && seen.insert(meta.pubkey) {
                    signers.push(self.keys.get(&meta.pubkey).ok_or_else(|| {
                        format!("No fresh local test signer for {}", meta.pubkey)
                    })?);
                }
            }
        }
        let previous = self.last_test_blockhash.clone();
        let blockhash_text = fresh_blockhash(previous.as_deref(), || {
            self.rpc
                .call("getLatestBlockhash", json!([{"commitment":"confirmed"}]))?["value"]
                ["blockhash"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "RPC returned no blockhash".into())
        })?;
        self.last_test_blockhash = Some(blockhash_text.clone());
        let blockhash = blockhash_text
            .parse()
            .map_err(|_| "Invalid recent blockhash")?;
        let transaction = Transaction::new(
            &signers,
            Message::new(instructions, Some(&self.payer.pubkey())),
            blockhash,
        );
        let bytes = bincode::serialize(&transaction)
            .map_err(|e| format!("Cannot encode transaction: {e}"))?;
        if bytes.len() > 1232 {
            return Err("Transaction exceeds Solana packet limit".into());
        }
        let signature = transaction
            .signatures
            .first()
            .ok_or("Transaction has no signature")?
            .to_string();
        self.rpc.record("test transaction",&signature,"pending","Locally signed signature flushed before sendTransaction; inspect this signature before any retry")?;
        let encoded = STANDARD.encode(bytes);
        let submitted=match self.rpc.call("sendTransaction",json!([encoded,{"encoding":"base64","skipPreflight":true,"preflightCommitment":"confirmed","maxRetries":3}])) {
            Ok(value)=>value,
            Err(error)=>{self.rpc.uncertain(&signature,"sendTransaction response was uncertain; inspect this signature before retrying")?;return Err(format!("sendTransaction response was uncertain for {signature}: {error}"));}
        };
        if submitted.as_str() != Some(&signature) {
            self.rpc.uncertain(
                &signature,
                "RPC returned a different signature; inspect the local signature before retrying",
            )?;
            return Err(format!(
                "RPC signature did not match locally signed transaction {signature}"
            ));
        }
        let confirmed_status = self.rpc.confirm("test transaction", &signature, None)?;
        if confirmed_status.get("err").is_none() {
            self.rpc.update(
                &signature,
                json!({"outcome":"confirmed-no-metadata","reason":"getSignatureStatuses omitted the transaction error field"}),
            )?;
            return Err(format!(
                "Transaction {signature} status omitted its error field"
            ));
        }
        let metadata_deadline = Instant::now() + Duration::from_secs(20);
        let mut last_metadata_error = "getTransaction returned null after confirmation".to_owned();
        let transaction = loop {
            if Instant::now() >= metadata_deadline {
                self.rpc.update(
                    &signature,
                    json!({"outcome":"confirmed-no-metadata","reason":last_metadata_error}),
                )?;
                return Err(format!(
                    "Transaction {signature} confirmed but matching RPC metadata did not arrive"
                ));
            }
            match self.rpc.transaction(&signature) {
                Ok(value)
                    if !value.is_null()
                        && value["meta"].is_object()
                        && value["meta"].get("err").is_some() =>
                {
                    break value
                }
                Ok(_) => {
                    last_metadata_error =
                        "getTransaction returned null or incomplete metadata".into()
                }
                Err(error) => last_metadata_error = error,
            }
            thread::sleep(Duration::from_millis(500));
        };
        let meta = &transaction["meta"];
        let error = meta["err"].clone();
        if error != confirmed_status["err"] {
            self.rpc.update(
                &signature,
                json!({"outcome":"metadata-mismatch","statusError":confirmed_status["err"],"transactionError":error}),
            )?;
            return Err(format!(
                "Transaction {signature} status and transaction metadata errors do not match"
            ));
        }
        let ok = error.is_null();
        let logs = meta["logMessages"].as_array().cloned().unwrap_or_default();
        let units = meta["computeUnitsConsumed"].as_u64().unwrap_or(0);
        let code = extract_error(&error);
        let result = json!({"ok":ok,"units":units,"logs":logs.clone(),"code":code,"error":if ok {Value::Null} else {json!(error.to_string())},"signature":signature});
        self.rpc.update(&signature,json!({"outcome":if ok {"confirmed-success"} else {"confirmed-rejection"},"transactionError":error,"units":units,"logs":logs}))?;
        Ok(result)
    }
    fn request(&mut self, value: Value) -> Result<Value> {
        match text(&value, "op")? {
            "hello" => Ok(self.hello.clone()),
            "key" => {
                let name = text(&value, "name")?;
                if name.is_empty() || name.len() > 128 {
                    return Err("Test key name must contain 1 to 128 bytes".into());
                }
                if let Some(key) = self.keys_by_name.get(name) {
                    return Ok(json!(key.to_string()));
                }
                let key = Keypair::new();
                let address = key.pubkey();
                if address == self.payer.pubkey()
                    || address == self.program.pubkey()
                    || self.keys.contains_key(&address)
                {
                    return Err("Fresh test key collision".into());
                }
                let name_path = self.dir.join(format!("account-{:04}.json", self.next_key));
                self.next_key += 1;
                save_key(&name_path, &key)?;
                self.keys.insert(address, key);
                self.keys_by_name.insert(name.to_owned(), address);
                self.save_named_keys()?;
                Ok(json!(address.to_string()))
            }
            "account" => Ok(self
                .rpc
                .account(pubkey(&value, "address")?)?
                .unwrap_or(Value::Null)),
            "send" => {
                let instructions = list(&value, "instructions")?
                    .iter()
                    .map(instruction)
                    .collect::<Result<Vec<_>>>()?;
                self.send(&instructions)
            }
            "create" => {
                let mut instructions = Vec::new();
                for allocation in list(&value, "allocations")? {
                    let bytes = allocation["bytes"]
                        .as_u64()
                        .filter(|bytes| *bytes <= 10 * 1024 * 1024)
                        .ok_or("Invalid account allocation size")?;
                    let address = pubkey(allocation, "address")?;
                    if !self.keys.contains_key(&address) {
                        return Err(format!("Account {address} has no fresh named test signer"));
                    }
                    let owner = pubkey(allocation, "owner")?;
                    instructions.push(system::create_account(
                        &self.payer.pubkey(),
                        &address,
                        self.rpc.rent(bytes as usize)?,
                        bytes,
                        &owner,
                    ));
                }
                for initializer in list(&value, "instructions")? {
                    instructions.push(instruction(initializer)?);
                }
                self.send(&instructions)
            }
            _ => Err("Unknown local RPC test runner operation".into()),
        }
    }
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 3 {
        eprintln!("Usage: bend-local-runner {LOCAL_URL} ELF BUILD_RUN_DIRECTORY");
        std::process::exit(2);
    }
    let endpoint = args[0].clone();
    let dir = PathBuf::from(&args[2]);
    let run = Runner::new(endpoint, PathBuf::from(&args[1]), dir.clone());
    let mut runner = match run {
        Ok(runner) => runner,
        Err(error) => {
            if dir.exists() {
                let _ = write_json(
                    &dir.join("failure.json"),
                    &json!({"passed":false,"error":error}),
                );
            }
            eprintln!("Local RPC test runner startup failed: {error}");
            std::process::exit(1);
        }
    };
    for line in io::stdin().lock().lines() {
        let response = line
            .map_err(|e| e.to_string())
            .and_then(|line| serde_json::from_str::<Value>(&line).map_err(|e| e.to_string()))
            .and_then(|value| runner.request(value));
        let output = match response {
            Ok(value) => json!({"success":true,"value":value}),
            Err(error) => json!({"success":false,"error":error}),
        };
        println!("{output}");
        let _ = io::stdout().flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_every_noncanonical_endpoint() {
        for endpoint in [
            "http://127.0.0.1:8899",
            "http://localhost:18899",
            "http://127.0.0.1:18899/",
            "https://127.0.0.1:18899",
            "https://api.devnet.solana.com",
        ] {
            assert!(http_post(endpoint, b"{}").is_err(), "accepted {endpoint}");
        }
    }
    #[test]
    fn finds_custom_codes_from_confirmed_rpc_errors() {
        assert_eq!(
            code_from_error(&json!({"InstructionError":[2,{"Custom":257}]})),
            Some(257)
        );
        assert_eq!(
            code_from_error(&json!({"InstructionError":[0,"InvalidArgument"]})),
            None
        );
    }
    #[test]
    fn deployment_signatures_are_public_and_deduplicated() {
        assert_eq!(
            deployment_signatures(br#"{"result":{"signature":"abc"},"other":{"signature":"abc"}}"#),
            vec!["abc"]
        );
        assert!(deployment_signatures(b"invalid json").is_empty());
    }
    #[test]
    fn deployment_command_allows_only_one_signing_attempt() {
        let command = deploy_command(
            LOCAL_URL,
            Path::new("build/payer.json"),
            Path::new("build/program.so"),
            Path::new("build/program-key.json"),
        );
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let attempts = args
            .windows(2)
            .filter(|pair| pair[0] == "--max-sign-attempts" && pair[1] == "1")
            .count();
        assert_eq!(attempts, 1, "deployment args: {args:?}");
        assert!(args.contains(&"--use-rpc".to_owned()));
    }
    #[test]
    fn repeated_test_plans_wait_for_a_new_blockhash() {
        let values = ["same-blockhash", "same-blockhash", "next-blockhash"];
        let mut index = 0;
        let fresh = fresh_blockhash(Some("same-blockhash"), || {
            let value = values[index].to_owned();
            index += 1;
            Ok(value)
        })
        .unwrap();
        assert_eq!(fresh, "next-blockhash");
        assert_eq!(index, 3);
        assert_eq!(
            fresh_blockhash(None, || Ok("first".into())).unwrap(),
            "first"
        );
    }
}
