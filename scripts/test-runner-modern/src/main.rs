//! Private JSON-lines transport for the TypeScript test SDK on LiteSVM 0.13.0
//! (SBPFv0 and SBPFv3). Same protocol as scripts/test-runner. No RPC or sockets.
use agave_feature_set::FeatureSet;
use litesvm::LiteSVM;
use serde_json::{json, Value};
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_address::Address as Pubkey;
use solana_signer::Signer;
use solana_system_interface::instruction as system;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use std::{
    collections::{HashMap, HashSet},
    io::{self, BufRead, Write},
};

type Result<T> = std::result::Result<T, String>;
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str().ok_or(format!("Missing string {k}"))
}
fn key(v: &Value, k: &str) -> Result<Pubkey> {
    text(v, k)?
        .parse()
        .map_err(|_| format!("Invalid address {k}"))
}
fn list<'a>(v: &'a Value, k: &str) -> Result<&'a Vec<Value>> {
    v[k].as_array().ok_or(format!("Missing array {k}"))
}
fn instruction(v: &Value) -> Result<Instruction> {
    let accounts = list(v, "accounts")?
        .iter()
        .map(|a| {
            Ok(AccountMeta {
                pubkey: key(a, "address")?,
                is_signer: a["signer"].as_bool().ok_or("Missing signer flag")?,
                is_writable: a["writable"].as_bool().ok_or("Missing writable flag")?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let data =
        serde_json::from_value(v["data"].clone()).map_err(|_| "Instruction bytes must be u8[]")?;
    Ok(Instruction {
        program_id: key(v, "program")?,
        accounts,
        data,
    })
}
struct Runner {
    svm: LiteSVM,
    payer: Keypair,
    keys: HashMap<Pubkey, Keypair>,
}
impl Runner {
    fn new() -> Self {
        let payer = Keypair::new_from_array([0; 32]);
        // Builtins and the program runtime must be created after the feature set;
        // LiteSVM::new() fixes its bundled mainnet list, which refuses SBPFv3.
        let mut svm = LiteSVM::default()
            .with_feature_set(FeatureSet::all_enabled())
            .with_builtins()
            .with_lamports(1_000_000_000_000_000)
            .with_sysvars()
            .with_feature_accounts()
            .with_default_programs()
            .with_sigverify(true)
            .with_blockhash_check(true)
            .with_transaction_history(0);
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        Self {
            svm,
            payer,
            keys: HashMap::new(),
        }
    }
    fn send(&mut self, ixs: &[Instruction]) -> Result<Value> {
        if ixs.is_empty() {
            return Err("Expected at least one instruction".into());
        }
        let mut keys = HashSet::new();
        let mut signers = vec![&self.payer];
        keys.insert(self.payer.pubkey());
        for ix in ixs {
            for meta in &ix.accounts {
                if meta.is_signer && keys.insert(meta.pubkey) {
                    signers.push(
                        self.keys
                            .get(&meta.pubkey)
                            .ok_or(format!("No test signer for {}", meta.pubkey))?,
                    );
                }
            }
        }
        let transaction = Transaction::new(
            &signers,
            Message::new(ixs, Some(&self.payer.pubkey())),
            self.svm.latest_blockhash(),
        );
        Ok(match self.svm.send_transaction(transaction) {
            Ok(meta) => json!({"ok":true,"units":meta.compute_units_consumed,"logs":meta.logs}),
            Err(error) => {
                let code = match error.err {
                    TransactionError::InstructionError(_, InstructionError::Custom(code)) => {
                        Some(code)
                    }
                    _ => None,
                };
                json!({"ok":false,"code":code,"error":format!("{:?}",error.err),"units":error.meta.compute_units_consumed,"logs":error.meta.logs})
            }
        })
    }
    fn request(&mut self, v: Value) -> Result<Value> {
        match text(&v,"op")? {
            "hello"=>Ok(json!({"payer":self.payer.pubkey().to_string(),"runtime":"LiteSVM 0.13.0 (all-enabled features)"})),
            "key"=>{
                let seed=v["seed"].as_u64().filter(|n|*n>0&&*n<256).ok_or("Test key seed must be 1–255")? as u8;
                let key=Keypair::new_from_array([seed;32]);let address=key.pubkey();self.keys.insert(address,key);
                Ok(json!(address.to_string()))
            },
            "load"=>{self.svm.add_program_from_file(key(&v,"program")?,text(&v,"elf")?).map_err(|e|format!("Cannot load SBF: {e:?}"))?;Ok(Value::Null)},
            "account"=>Ok(self.svm.get_account(&key(&v,"address")?).map(|a|json!({"lamports":a.lamports,"owner":a.owner.to_string(),"executable":a.executable,"data":a.data})).unwrap_or(Value::Null)),
            "send"=>self.send(&list(&v,"instructions")?.iter().map(instruction).collect::<Result<Vec<_>>>()?),
            "create"=>{
                let mut ixs=vec![];
                for a in list(&v,"allocations")?{
                    let bytes=a["bytes"].as_u64().filter(|n|*n<=10*1024*1024).ok_or("Invalid account allocation size")?;
                    ixs.push(system::create_account(&self.payer.pubkey(),&key(a,"address")?,self.svm.minimum_balance_for_rent_exemption(bytes as usize),bytes,&key(a,"owner")?));
                }
                for ix in list(&v,"instructions")?{ixs.push(instruction(ix)?);}
                self.send(&ixs)
            },
            _=>Err("Unknown test runner operation".into())
        }
    }
}
fn main() {
    let mut runner = Runner::new();
    for line in io::stdin().lock().lines() {
        let result = line
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
            .and_then(|v| runner.request(v));
        let response = match result {
            Ok(value) => json!({"success":true,"value":value}),
            Err(error) => json!({"success":false,"error":error}),
        };
        println!("{response}");
        io::stdout().flush().unwrap();
    }
}
