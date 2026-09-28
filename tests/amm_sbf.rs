use super::token_fixture::TokenFixture;
use super::*;
use solana_program_pack::Pack;
use spl_token::{
    instruction as token,
    state::{Account as TokenAccount, Mint},
};

struct Amm {
    f: TokenFixture,
    quote: Pubkey,
    user_quote: Pubkey,
    quote_vault: Pubkey,
    lp: Pubkey,
    user_lp: Pubkey,
}

fn create_token(f: &mut TokenFixture, mint: Pubkey, owner: Pubkey) -> Pubkey {
    create_token_key(f, mint, owner, Keypair::new())
}
fn create_token_key(f: &mut TokenFixture, mint: Pubkey, owner: Pubkey, account: Keypair) -> Pubkey {
    f.send_extra(
        &[
            f.create(account.pubkey(), TokenAccount::LEN, spl_token::id()),
            token::initialize_account3(&spl_token::id(), &account.pubkey(), &mint, &owner).unwrap(),
        ],
        &[&account],
    )
    .unwrap();
    account.pubkey()
}

impl Amm {
    fn new() -> Self {
        Self::with_program(
            &std::env::var("AMM_TEST_ELF").unwrap_or_else(|_| "build/amm.so".into()),
            false,
        )
    }
    fn with_program(elf: &str, deterministic: bool) -> Self {
        Self::with_program_interface(elf, deterministic, "build/amm.interface.json")
    }
    fn with_program_interface(elf: &str, deterministic: bool, interface: &str) -> Self {
        let mut f = TokenFixture::with_program_seeded_interface(elf, deterministic, interface);
        let key = |marker| {
            if deterministic {
                Keypair::new_from_array([marker; 32])
            } else {
                Keypair::new()
            }
        };
        let quote = key(8);
        let lp = key(9);
        for (key, authority) in [(&quote, f.actor.pubkey()), (&lp, f.custody)] {
            f.send_extra(
                &[
                    f.create(key.pubkey(), Mint::LEN, spl_token::id()),
                    token::initialize_mint2(
                        &spl_token::id(),
                        &key.pubkey(),
                        &authority,
                        (key.pubkey() == quote.pubkey()).then_some(&authority),
                        6,
                    )
                    .unwrap(),
                ],
                &[key],
            )
            .unwrap();
        }
        let actor = f.actor.pubkey();
        let custody = f.custody;
        let user_quote = create_token_key(&mut f, quote.pubkey(), actor, key(10));
        let quote_vault = create_token_key(&mut f, quote.pubkey(), custody, key(11));
        let user_lp = create_token_key(&mut f, lp.pubkey(), actor, key(12));
        f.send(&[
            token::mint_to(
                &spl_token::id(),
                &f.mint.pubkey(),
                &f.user_token.pubkey(),
                &actor,
                &[],
                999_000,
            )
            .unwrap(),
            token::mint_to(
                &spl_token::id(),
                &quote.pubkey(),
                &user_quote,
                &actor,
                &[],
                1_000_000,
            )
            .unwrap(),
        ])
        .unwrap();
        f.max_cu = 0;
        Self {
            f,
            quote: quote.pubkey(),
            user_quote,
            quote_vault,
            lp: lp.pubkey(),
            user_lp,
        }
    }
    fn keys(&self) -> [Pubkey; 5] {
        [
            self.f.mint.pubkey(),
            self.quote,
            self.lp,
            self.f.vault_token.pubkey(),
            self.quote_vault,
        ]
    }
    fn accounts(&self, initialize: bool) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.f.state.pubkey(), initialize),
            AccountMeta::new_readonly(self.f.actor.pubkey(), true),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(self.f.custody, false),
            AccountMeta::new(self.f.user_token.pubkey(), false),
            AccountMeta::new(self.f.vault_token.pubkey(), false),
            AccountMeta::new_readonly(self.f.mint.pubkey(), false),
            AccountMeta::new(self.user_quote, false),
            AccountMeta::new(self.quote_vault, false),
            AccountMeta::new_readonly(self.quote, false),
            AccountMeta::new(self.user_lp, false),
            AccountMeta::new(self.lp, false),
        ]
    }
    fn instruction(&self, op: u8, values: [u64; 3], direction: bool) -> Instruction {
        let mut data = vec![u8::from(op != 0), op];
        if op == 0 {
            data.push(0); // Config.
            for key in self.keys() {
                data.push(0);
                data.extend_from_slice(key.as_ref());
            }
        }
        if op == 3 {
            data.push(u8::from(direction));
        }
        for value in values.iter().take(if op == 3 { 2 } else { 3 }) {
            data.push(0);
            data.extend_from_slice(&value.to_le_bytes());
        }
        data.resize(195, 0);
        Instruction {
            program_id: self.f.program,
            accounts: self.accounts(op == 0),
            data,
        }
    }
    fn initialize(&mut self, x: u64, y: u64, shares: u64) {
        self.f
            .send(&[
                self.f
                    .create(self.f.state.pubkey(), self.f.size, self.f.program),
                self.instruction(0, [x, y, shares], false),
            ])
            .unwrap();
    }
    fn balance(&self, key: Pubkey) -> u64 {
        TokenAccount::unpack(&self.f.svm.get_account(&key).unwrap().data)
            .unwrap()
            .amount
    }
    fn supply(&self) -> u64 {
        Mint::unpack(&self.f.svm.get_account(&self.lp).unwrap().data)
            .unwrap()
            .supply
    }
    fn recorded(&self) -> [u64; 3] {
        let state = self.f.svm.get_account(&self.f.state.pubkey()).unwrap();
        assert_eq!(state.data.len(), 216);
        assert_eq!(&state.data[..20], &self.f.header);
        assert_eq!(&state.data[20..23], &[1, 0, 0]);
        for (i, key) in self.keys().iter().enumerate() {
            assert_eq!(state.data[23 + 33 * i], 0);
            assert_eq!(
                &state.data[24 + 33 * i..56 + 33 * i],
                key.as_ref(),
                "immutable config"
            );
        }
        assert_eq!(state.data[188], 0);
        std::array::from_fn(|i| {
            assert_eq!(state.data[189 + 9 * i], 0);
            u64::from_le_bytes(state.data[190 + 9 * i..198 + 9 * i].try_into().unwrap())
        })
    }
    fn solvent(&self) {
        let [x, y, shares] = self.recorded();
        assert!(self.balance(self.f.vault_token.pubkey()) >= x);
        assert!(self.balance(self.quote_vault) >= y);
        assert!(self.supply() <= shares - 1000);
    }
    fn snapshot(&self) -> Vec<Option<Account>> {
        let mut values = self.f.snapshot();
        for key in [
            self.quote,
            self.user_quote,
            self.quote_vault,
            self.lp,
            self.user_lp,
        ] {
            values.push(self.f.svm.get_account(&key));
        }
        values
    }
    fn reject(&mut self, ix: Instruction, code: Option<u32>) {
        let before = self.snapshot();
        let error = self.f.send(&[ix]).unwrap_err();
        if let Some(code) = code {
            assert_eq!(
                error.err,
                TransactionError::InstructionError(0, InstructionError::Custom(code)),
                "{:?}",
                error.meta.logs
            );
        }
        assert_eq!(
            self.snapshot(),
            before,
            "rejected operation changed state/tokens"
        );
    }
}

#[test]
fn amm_initializes_deposits_swaps_both_ways_and_withdraws() {
    let mut a = Amm::new();
    a.initialize(10_000, 10_000, 9_000);
    assert_eq!(a.recorded(), [10_000, 10_000, 10_000]);
    assert_eq!(a.supply(), 9_000);
    assert_eq!(a.balance(a.user_lp), 9_000);
    a.f.send(&[a.instruction(1, [5_000, 5_000, 5_000], false)])
        .unwrap();
    assert_eq!(a.recorded(), [15_000, 15_000, 15_000]);
    assert_eq!(a.supply(), 14_000);
    let mut x = 15_000u64;
    let mut y = 15_000u64;
    for direction in [true, false] {
        let gross = 1_000;
        let effective = 997;
        let (input, output) = if direction { (x, y) } else { (y, x) };
        let received = (u128::from(output) * effective / (u128::from(input) + effective)) as u64;
        let before = u128::from(x) * u128::from(y);
        a.f.send(&[a.instruction(3, [gross, received, 0], direction)])
            .unwrap();
        if direction {
            x += gross;
            y -= received;
        } else {
            y += gross;
            x -= received;
        }
        assert_eq!(a.recorded(), [x, y, 15_000]);
        assert!(u128::from(x) * u128::from(y) >= before);
        a.solvent();
    }
    let dx = (u128::from(x) * 14_000 / 15_000) as u64;
    let dy = (u128::from(y) * 14_000 / 15_000) as u64;
    a.f.send(&[a.instruction(2, [14_000, dx, dy], false)])
        .unwrap();
    assert_eq!(a.recorded(), [x - dx, y - dy, 1000]);
    assert_eq!(a.supply(), 0);
    assert_eq!(a.balance(a.user_lp), 0);
    a.solvent();
    a.reject(a.instruction(2, [1, 0, 0], false), Some(262));
    // Locked liquidity remains available to price a new deposit.
    a.f.send(&[a.instruction(1, [1000, x - dx, y - dy], false)])
        .unwrap();
    assert_eq!(a.supply(), 1000);
    a.solvent();
}

#[test]
fn amm_rejects_unsigned_slippage_zero_reinitialization_and_wrong_reserves() {
    let mut a = Amm::new();
    a.initialize(10_000, 10_000, 9_000);
    for (op, values, code) in [
        (1, [1, 0, 1], 261),
        (2, [1, 2, 0], 261),
        (3, [1000, 907, 0], 261),
        (3, [0, 0, 0], 260),
        (3, [1, 0, 0], 260),
        (1, [0, 0, 0], 260),
        (2, [9001, 0, 0], 262),
    ] {
        a.reject(a.instruction(op, values, true), Some(code));
    }
    let mut repeat = a.instruction(0, [10_000, 10_000, 0], false);
    repeat.data[0] = 1;
    repeat.accounts[0].is_signer = false;
    a.reject(repeat, Some(258));
    let mut unsigned = a.instruction(1, [1, 1, 1], false);
    unsigned.accounts[1].is_signer = false;
    a.reject(unsigned, Some(257));
    let mint = a.f.mint.pubkey();
    let custody = a.f.custody;
    let substitute = create_token(&mut a.f, mint, custody);
    let before = a.f.svm.get_account(&substitute);
    let mut wrong = a.instruction(3, [1000, 0, 0], true);
    wrong.accounts[5].pubkey = substitute;
    a.reject(wrong, Some(25));
    assert_eq!(a.f.svm.get_account(&substitute), before);
    a.solvent();
}

#[test]
fn amm_multiple_liquidity_providers_and_transferred_shares() {
    let mut a = Amm::new();
    a.initialize(10_000, 10_000, 9_000);
    let owner = a.f.attacker.pubkey();
    let base_mint = a.f.mint.pubkey();
    let other_base = create_token(&mut a.f, base_mint, owner);
    let other_quote = create_token(&mut a.f, a.quote, owner);
    let other_lp = create_token(&mut a.f, a.lp, owner);
    a.f.send(&[
        token::transfer_checked(
            &spl_token::id(),
            &a.f.user_token.pubkey(),
            &base_mint,
            &other_base,
            &a.f.actor.pubkey(),
            &[],
            5000,
            6,
        )
        .unwrap(),
        token::transfer_checked(
            &spl_token::id(),
            &a.user_quote,
            &a.quote,
            &other_quote,
            &a.f.actor.pubkey(),
            &[],
            5000,
            6,
        )
        .unwrap(),
    ])
    .unwrap();
    let other = |a: &Amm, op, values| {
        let mut instruction = a.instruction(op, values, false);
        instruction.accounts[1] = AccountMeta::new_readonly(owner, true);
        instruction.accounts[4] = AccountMeta::new(other_base, false);
        instruction.accounts[7] = AccountMeta::new(other_quote, false);
        instruction.accounts[10] = AccountMeta::new(other_lp, false);
        instruction
    };
    a.f.send(&[other(&a, 1, [5000, 5000, 5000])]).unwrap();
    assert_eq!(a.balance(other_lp), 5000);
    assert_eq!(a.balance(a.user_lp), 9000);
    assert_eq!(a.recorded(), [15000, 15000, 15000]);
    a.f.send(&[token::transfer_checked(
        &spl_token::id(),
        &a.user_lp,
        &a.lp,
        &other_lp,
        &a.f.actor.pubkey(),
        &[],
        1000,
        6,
    )
    .unwrap()])
        .unwrap();
    a.f.send(&[other(&a, 2, [6000, 6000, 6000])]).unwrap();
    assert_eq!(a.balance(other_lp), 0);
    assert_eq!(a.balance(other_base), 6000);
    assert_eq!(a.balance(other_quote), 6000);
    assert_eq!(a.recorded(), [9000, 9000, 9000]);
    assert_eq!(a.supply(), 8000);
    a.solvent();
    // Owning fewer shares than requested cannot redeem another holder's stake.
    let before = [
        a.balance(other_base),
        a.balance(other_quote),
        a.balance(other_lp),
    ];
    a.reject(other(&a, 2, [1, 0, 0]), Some(1));
    assert_eq!(
        [
            a.balance(other_base),
            a.balance(other_quote),
            a.balance(other_lp)
        ],
        before
    );
}

#[test]
fn amm_late_token_failures_undo_mint_burn_transfers_and_state() {
    let mut a = Amm::new();
    a.initialize(10_000, 10_000, 9000);
    a.f.send(&[token::freeze_account(
        &spl_token::id(),
        &a.quote_vault,
        &a.quote,
        &a.f.actor.pubkey(),
        &[],
    )
    .unwrap()])
        .unwrap();
    let before = a.snapshot();
    let failed =
        a.f.send(&[a.instruction(2, [1000, 1000, 1000], false)])
            .unwrap_err();
    assert_eq!(
        failed
            .meta
            .logs
            .iter()
            .filter(|line| line.starts_with(&format!("Program {} invoke", spl_token::id())))
            .count(),
        3
    );
    assert_eq!(
        a.snapshot(),
        before,
        "burn and base transfer must roll back on frozen quote reserve"
    );
    a.reject(a.instruction(3, [1000, 0, 0], true), None);
    a.f.send(&[token::thaw_account(
        &spl_token::id(),
        &a.quote_vault,
        &a.quote,
        &a.f.actor.pubkey(),
        &[],
    )
    .unwrap()])
        .unwrap();
    a.f.send(&[a.instruction(2, [1000, 1000, 1000], false)])
        .unwrap();
    assert_eq!(a.recorded(), [9000, 9000, 9000]);
    a.solvent();
    // A later instruction's slippage failure rolls back an earlier successful swap.
    let before = a.snapshot();
    a.f.send(&[
        a.instruction(3, [1000, 0, 0], true),
        a.instruction(2, [1, u64::MAX, 0], false),
    ])
    .unwrap_err();
    assert_eq!(a.snapshot(), before);
}

#[test]
fn amm_initial_funding_failure_rolls_back_creation_and_initial_limits() {
    let mut a = Amm::new();
    for (values, expected) in [
        ([10_000, 10_000, 9001], Some(261)),
        ([1000, 1000, 0], Some(260)),
        ([999, 999, 0], Some(260)),
        ([0, 10_000, 0], Some(259)),
        ([10_000, 1_000_001, 0], None),
    ] {
        let before = a.snapshot();
        let failure =
            a.f.send(&[
                a.f.create(a.f.state.pubkey(), a.f.size, a.f.program),
                a.instruction(0, values, false),
            ])
            .unwrap_err();
        if let Some(code) = expected {
            assert_eq!(
                failure.err,
                TransactionError::InstructionError(1, InstructionError::Custom(code))
            );
        }
        assert_eq!(a.snapshot(), before);
    }
    a.initialize(10_000, 40_000, 19_000);
    assert_eq!(a.recorded(), [10_000, 40_000, 20_000]);
    assert_eq!(a.supply(), 19_000);
    a.solvent();
}

#[test]
fn amm_typescript_client_instructions_execute_in_sbf() {
    #[derive(Deserialize)]
    struct Meta {
        address: Vec<u8>,
        #[serde(rename = "isSigner")]
        signer: bool,
        #[serde(rename = "isWritable")]
        writable: bool,
    }
    #[derive(Deserialize)]
    struct ClientInstruction {
        data: Vec<u8>,
        accounts: Vec<Meta>,
    }
    let vectors: Vec<ClientInstruction> = serde_json::from_slice(
        &std::fs::read("build/amm-client-vectors.json").expect("run npm run test:amm"),
    )
    .unwrap();
    assert_eq!(vectors.len(), 4);
    let mut a = Amm::new();
    let values = [
        [10000, 40000, 19000],
        [100, 100, 400],
        [100, 50, 200],
        [1000, 906, 0],
    ];
    for (i, vector) in vectors.into_iter().enumerate() {
        let mut data = vector.data;
        let metas = a.accounts(i == 0);
        assert_eq!(vector.accounts.len(), metas.len());
        for (index, (client, meta)) in vector.accounts.iter().zip(&metas).enumerate() {
            assert_eq!(client.address, vec![index as u8 + 1; 32]);
            assert_eq!(client.signer, meta.is_signer);
            assert_eq!(client.writable, meta.is_writable);
        }
        if i == 0 {
            for (j, (key, marker)) in a.keys().iter().zip([7, 10, 12, 6, 9]).enumerate() {
                let offset = 4 + 33 * j;
                assert_eq!(&data[offset..offset + 32], &[marker; 32]);
                data[offset..offset + 32].copy_from_slice(key.as_ref());
            }
        }
        assert_eq!(
            data,
            a.instruction(i as u8, values[i], true).data,
            "client and independent Rust codec disagree"
        );
        let instruction = Instruction {
            program_id: a.f.program,
            accounts: metas,
            data,
        };
        if i == 0 {
            a.f.send(&[
                a.f.create(a.f.state.pubkey(), a.f.size, a.f.program),
                instruction,
            ])
            .unwrap();
        } else {
            a.f.send(&[instruction]).unwrap();
        }
        a.solvent();
    }
    assert_eq!(a.recorded(), [11_000, 36_374, 20_000]);
}

#[test]
fn amm_full_width_liquidity_and_overflow_rejections() {
    let mut a = Amm::new();
    let x = (1u64 << 63) - 1000;
    let y = (1u64 << 63) + 1000;
    a.f.send(&[
        token::mint_to(
            &spl_token::id(),
            &a.f.mint.pubkey(),
            &a.f.user_token.pubkey(),
            &a.f.actor.pubkey(),
            &[],
            x - 1_000_000,
        )
        .unwrap(),
        token::mint_to(
            &spl_token::id(),
            &a.quote,
            &a.user_quote,
            &a.f.actor.pubkey(),
            &[],
            y - 1_000_000,
        )
        .unwrap(),
    ])
    .unwrap();
    let total = (1u64 << 63) - 1;
    a.initialize(x, y, total - 1000);
    assert_eq!(a.recorded(), [x, y, total]);
    assert_eq!(a.supply(), total - 1000);
    a.reject(a.instruction(3, [u64::MAX, 0, 0], true), Some(260));
    a.reject(
        a.instruction(1, [u64::MAX, u64::MAX, u64::MAX], false),
        Some(260),
    );
    a.reject(a.instruction(2, [u64::MAX, 0, 0], false), Some(262));
    let shares = total - 1000;
    let dx = (u128::from(x) * u128::from(shares) / u128::from(total)) as u64;
    let dy = (u128::from(y) * u128::from(shares) / u128::from(total)) as u64;
    a.f.send(&[a.instruction(2, [shares, dx, dy], false)])
        .unwrap();
    assert_eq!(a.recorded(), [x - dx, y - dy, 1000]);
    assert_eq!(a.supply(), 0);
    a.solvent();
}

#[test]
fn amm_donations_and_external_lp_burns_do_not_change_recorded_pricing() {
    let mut a = Amm::new();
    a.initialize(10_000, 10_000, 9000);
    a.f.send(&[
        token::transfer_checked(
            &spl_token::id(),
            &a.f.user_token.pubkey(),
            &a.f.mint.pubkey(),
            &a.f.vault_token.pubkey(),
            &a.f.actor.pubkey(),
            &[],
            777,
            6,
        )
        .unwrap(),
        token::burn_checked(
            &spl_token::id(),
            &a.user_lp,
            &a.lp,
            &a.f.actor.pubkey(),
            &[],
            100,
            6,
        )
        .unwrap(),
    ])
    .unwrap();
    assert_eq!(a.recorded(), [10_000, 10_000, 10_000]);
    assert_eq!(a.supply(), 8900);
    a.f.send(&[a.instruction(3, [1000, 906, 0], true)]).unwrap();
    assert_eq!(a.recorded(), [11_000, 9094, 10_000]);
    assert_eq!(a.balance(a.f.vault_token.pubkey()), 11_777);
    a.solvent();
}

#[derive(Debug, PartialEq, Eq)]
struct InvocationObservation {
    program_id: String,
    depth: usize,
    parent: Option<usize>,
    outcome: Option<&'static str>,
    inclusive_compute_units: Option<u64>,
}

/// Parse LiteSVM's stable program invocation and compute-consumption log lines.
/// CU values belong to individual invocations and include work done by nested
/// calls because they use the transaction's shared compute meter.
fn parse_invocation_observations(logs: &[String]) -> Result<Vec<InvocationObservation>, String> {
    let mut observations: Vec<InvocationObservation> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();

    for line in logs {
        let Some(rest) = line.strip_prefix("Program ") else {
            continue;
        };

        if let Some(invoke) = rest.strip_suffix(']') {
            if let Some((program_id, depth)) = invoke.rsplit_once(" invoke [") {
                let depth = depth
                    .parse::<usize>()
                    .map_err(|_| format!("invalid invocation depth in log: {line}"))?;
                if program_id.is_empty() || depth != stack.len() + 1 {
                    return Err(format!("unexpected invocation nesting in log: {line}"));
                }
                let index = observations.len();
                observations.push(InvocationObservation {
                    program_id: program_id.to_owned(),
                    depth,
                    parent: stack.last().copied(),
                    outcome: None,
                    inclusive_compute_units: None,
                });
                stack.push(index);
                continue;
            }
        }

        if let Some(consumed) = rest.strip_suffix(" compute units") {
            if let Some((program_id, counts)) = consumed.split_once(" consumed ") {
                let (used, remaining_at_entry) = counts
                    .split_once(" of ")
                    .ok_or_else(|| format!("invalid compute-consumption log: {line}"))?;
                let used = used
                    .parse::<u64>()
                    .map_err(|_| format!("invalid consumed CU value in log: {line}"))?;
                remaining_at_entry
                    .parse::<u64>()
                    .map_err(|_| format!("invalid remaining CU value in log: {line}"))?;
                let Some(index) = stack.last().copied() else {
                    return Err(format!(
                        "compute-consumption log outside invocation: {line}"
                    ));
                };
                let invocation = &mut observations[index];
                if invocation.program_id != program_id
                    || invocation.inclusive_compute_units.is_some()
                {
                    return Err(format!(
                        "compute-consumption log does not match active invocation: {line}"
                    ));
                }
                invocation.inclusive_compute_units = Some(used);
                continue;
            }
        }

        let completion = rest
            .strip_suffix(" success")
            .map(|program_id| (program_id, "success"))
            .or_else(|| {
                rest.split_once(" failed: ")
                    .map(|(program_id, _)| (program_id, "failed"))
            });
        if let Some((program_id, outcome)) = completion {
            let Some(index) = stack.pop() else {
                return Err(format!("program completion outside invocation: {line}"));
            };
            let invocation = &mut observations[index];
            if invocation.program_id != program_id || invocation.outcome.is_some() {
                return Err(format!(
                    "program completion does not match active invocation: {line}"
                ));
            }
            invocation.outcome = Some(outcome);
        }
    }

    if !stack.is_empty() {
        return Err("LiteSVM logs ended with an unclosed program invocation".to_owned());
    }
    if observations
        .iter()
        .any(|invocation| invocation.outcome.is_none())
    {
        return Err("LiteSVM invocation is missing a completion log".to_owned());
    }
    Ok(observations)
}

fn benchmark_invocation_json(
    logs: &[String],
    program_id: Pubkey,
    token_cpi_count: usize,
    expected_outcome: &'static str,
    transaction_compute_units: u64,
) -> serde_json::Value {
    let observations = parse_invocation_observations(logs).unwrap_or_else(|error| {
        panic!("cannot parse benchmark transaction logs: {error}\n{logs:#?}")
    });
    assert_eq!(
        observations.len(),
        1 + token_cpi_count,
        "unexpected invocation count or CPI structure: {logs:#?}"
    );
    let root = &observations[0];
    assert_eq!(
        root.program_id,
        program_id.to_string(),
        "root invocation: {logs:#?}"
    );
    assert_eq!(root.depth, 1, "root invocation depth: {logs:#?}");
    assert_eq!(root.parent, None, "root invocation parent: {logs:#?}");
    assert_eq!(
        root.outcome,
        Some(expected_outcome),
        "root outcome: {logs:#?}"
    );
    let root_compute_units = root
        .inclusive_compute_units
        .expect("benchmark root invocation must log inclusive compute units");
    assert_eq!(
        root_compute_units, transaction_compute_units,
        "root inclusive CU must agree with LiteSVM transaction CU: {logs:#?}"
    );

    let token_program = spl_token::id().to_string();
    let child_cpis: Vec<_> = observations
        .iter()
        .skip(1)
        .map(|invocation| {
            assert_eq!(
                invocation.program_id, token_program,
                "unexpected child program: {logs:#?}"
            );
            assert_eq!(invocation.depth, 2, "Token Program CPI depth: {logs:#?}");
            assert_eq!(
                invocation.parent,
                Some(0),
                "Token Program CPI parent: {logs:#?}"
            );
            assert_eq!(
                invocation.outcome,
                Some("success"),
                "Token Program CPI outcome: {logs:#?}"
            );
            serde_json::json!({
                "depth": invocation.depth,
                "outcome": invocation.outcome,
                "inclusiveComputeUnits": invocation.inclusive_compute_units
                    .expect("Token Program CPI must log inclusive compute units"),
                "parentInvocation": invocation.parent,
            })
        })
        .collect();
    assert_eq!(
        child_cpis.len(),
        token_cpi_count,
        "Token Program CPI count: {logs:#?}"
    );
    let observed_token_cpi_count = child_cpis.len();

    serde_json::json!({
        "root": {
            "programId": root.program_id,
            "depth": root.depth,
            "outcome": root.outcome,
            "inclusiveComputeUnits": root_compute_units,
        },
        "childTokenProgramCpis": child_cpis,
        "tokenCpiCount": observed_token_cpi_count,
    })
}

#[test]
fn amm_invocation_log_parser_tracks_nested_inclusive_cu_by_invocation() {
    let program = "Amm111111111111111111111111111111111111111";
    let token = spl_token::id().to_string();
    let logs = [
        format!("Program {program} invoke [1]"),
        format!("Program {token} invoke [2]"),
        format!("Program {token} consumed 4000 of 180000 compute units"),
        format!("Program {token} success"),
        format!("Program {program} consumed 12000 of 200000 compute units"),
        format!("Program {program} success"),
    ];
    let parsed = parse_invocation_observations(&logs).unwrap();
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].depth, 1);
    assert_eq!(parsed[0].inclusive_compute_units, Some(12_000));
    assert_eq!(parsed[1].depth, 2);
    assert_eq!(parsed[1].parent, Some(0));
    assert_eq!(parsed[1].inclusive_compute_units, Some(4_000));
    // The root's 12,000 CU already includes the 4,000 CU child; summing these
    // invocation readings would double count the Token Program work.
}

/// Compare complete transactions with fixed public test keys, the same program
/// address, and byte-identical account fixtures. These are observed costs, not
/// worst-case bounds. Kept explicit because it requires the separate Rust ELF.
#[test]
#[ignore = "run the AMM benchmark command after building both implementations"]
fn amm_benchmark_identical_fixtures() {
    let mut bend = Amm::with_program("build/amm.so", true);
    let mut rust = Amm::with_program("build/amm-rust.so", true);
    assert_eq!(bend.f.program, rust.f.program);
    assert_eq!(bend.f.state.pubkey(), rust.f.state.pubkey());
    assert_eq!(bend.f.custody, rust.f.custody);
    assert_eq!(bend.keys(), rust.keys());
    assert_eq!(bend.snapshot(), rust.snapshot());
    // Allocate outside the measured transaction so initialization costs describe
    // the AMM itself. Both state accounts still sign the initialization call.
    for a in [&mut bend, &mut rust] {
        a.f.send(&[a.f.create(a.f.state.pubkey(), a.f.size, a.f.program)])
            .unwrap();
    }
    let mut rows = Vec::new();
    let scenarios = [
        // Successful fixture CPI counts: transfer/transfer/mint, transfer/transfer/mint,
        // transfer/transfer, transfer/transfer, and burn/transfer/transfer.
        ("initialize", 0, [100_000, 400_000, 199_000], false, None, 3),
        ("deposit", 1, [10_000, 5_000, 20_000], false, None, 3),
        ("swap_base", 3, [1_000, 1, 0], true, None, 2),
        ("swap_quote", 3, [1_000, 1, 0], false, None, 2),
        ("withdraw", 2, [10_000, 1, 1], false, None, 3),
        (
            "reject_slippage",
            3,
            [1_000, u64::MAX, 0],
            true,
            Some(261),
            0,
        ),
        ("reject_zero_input", 3, [0, 0, 0], true, Some(260), 0),
        (
            "reject_locked_shares",
            2,
            [u64::MAX, 0, 0],
            false,
            Some(262),
            0,
        ),
    ];
    for (name, op, values, direction, error, expected_token_cpis) in scenarios {
        let bi = bend.instruction(op, values, direction);
        let ri = rust.instruction(op, values, direction);
        assert_eq!(bi, ri);
        assert_eq!(bend.snapshot(), rust.snapshot(), "before {name}");
        let before = bend.snapshot();
        let br = bend.f.send(&[bi]);
        let rr = rust.f.send(&[ri]);
        let (bm, rm) = match error {
            None => (br.unwrap(), rr.unwrap()),
            Some(code) => {
                let b = br.unwrap_err();
                let r = rr.unwrap_err();
                assert_eq!(b.err, r.err);
                assert_eq!(
                    b.err,
                    TransactionError::InstructionError(0, InstructionError::Custom(code))
                );
                assert_eq!(bend.snapshot(), before, "Bend rollback: {name}");
                assert_eq!(rust.snapshot(), before, "Rust rollback: {name}");
                (b.meta, r.meta)
            }
        };
        assert_eq!(bend.snapshot(), rust.snapshot(), "after {name}");
        assert_eq!(bm.return_data, rm.return_data, "return data: {name}");
        let expected_outcome = if error.is_some() { "failed" } else { "success" };
        let bend_invocations = benchmark_invocation_json(
            &bm.logs,
            bend.f.program,
            expected_token_cpis,
            expected_outcome,
            bm.compute_units_consumed,
        );
        let rust_invocations = benchmark_invocation_json(
            &rm.logs,
            rust.f.program,
            expected_token_cpis,
            expected_outcome,
            rm.compute_units_consumed,
        );
        rows.push(serde_json::json!({
            "operation": name,
            "bendCU": bm.compute_units_consumed,
            "rustCU": rm.compute_units_consumed,
            "bendInvocations": bend_invocations,
            "rustInvocations": rust_invocations,
            "error": error,
        }));
    }
    let report = serde_json::json!({"runtime":"LiteSVM 0.7.1", "target":"SBF v0 / generic",
        "fixture":"fixed public test seeds 1..12; program bytes [42;32]",
        "program":bend.f.program.to_string(),"custody":bend.f.custody.to_string(),
        "state":bend.f.state.pubkey().to_string(),"rows":rows,
        "bendElfBytes":std::fs::metadata("build/amm.so").unwrap().len(),
        "rustElfBytes":std::fs::metadata("build/amm-rust.so").unwrap().len()});
    std::fs::write(
        "build/amm-benchmark.json",
        serde_json::to_string_pretty(&report).unwrap() + "\n",
    )
    .unwrap();
    println!("{report}");
}

const PHASE_MARKERS: [&str; 8] = [
    "baseline",
    "accounts_parsed",
    "parsed_pda",
    "decoded_clock",
    "transition",
    "validated",
    "token_executed",
    "state_written",
];

/// The diagnostic copies emit one `sol_log_compute_units_` line per reached
/// boundary. LiteSVM also emits CPI logs, so only root invocation readings count.
fn phase_readings(logs: &[String], reached: usize) -> Vec<serde_json::Value> {
    let mut depth = 0usize;
    let mut readings = Vec::new();
    for line in logs {
        if let Some(rest) = line.strip_prefix("Program ") {
            if let Some((_, level)) = rest.strip_suffix(']').and_then(|x| x.rsplit_once(" invoke [")) {
                depth += 1;
                assert_eq!(level.parse::<usize>().unwrap(), depth, "{line}");
            } else if rest.ends_with(" success") || rest.contains(" failed: ") {
                assert!(depth > 0, "completion outside invocation: {line}");
                depth -= 1;
            }
        }
        if let Some(value) = line.strip_prefix("Program consumption: ") {
            assert_eq!(depth, 1, "CU marker outside root AMM invocation: {line}");
            let remaining = value
                .strip_suffix(" units remaining")
                .unwrap_or_else(|| panic!("malformed CU marker: {line}"))
                .parse::<u64>()
                .unwrap();
            let index = readings.len();
            assert!(index < reached, "unexpected extra CU marker: {logs:#?}");
            readings.push(serde_json::json!({
                "stage": PHASE_MARKERS[index],
                "remainingCU": remaining,
                "rawLog": line,
            }));
        }
    }
    assert_eq!(depth, 0, "unclosed invocation in CU marker logs");
    assert_eq!(readings.len(), reached, "missing CU marker: {logs:#?}");
    for pair in readings.windows(2) {
        assert!(pair[0]["remainingCU"].as_u64().unwrap() > pair[1]["remainingCU"].as_u64().unwrap(),
            "CU readings must strictly decrease");
    }
    readings
}

fn phase_intervals(readings: &[serde_json::Value]) -> Vec<serde_json::Value> {
    readings.windows(2).map(|pair| serde_json::json!({
        "from": pair[0]["stage"],
        "to": pair[1]["stage"],
        "deltaCU": pair[0]["remainingCU"].as_u64().unwrap()
            - pair[1]["remainingCU"].as_u64().unwrap(),
    })).collect()
}

/// Fixed public fixtures, same address and input bytes as the matched release
/// benchmark. This test is intentionally ignored by ordinary Cargo runs.
#[test]
#[ignore = "run npm run benchmark:amm:phases to build diagnostic ELFs"]
fn amm_phase_diagnostic_identical_fixtures() {
    let interface = "build/amm-phases/checked.interface.json";
    let mut bend = Amm::with_program_interface("build/amm-phases/bend.so", true, interface);
    let mut rust = Amm::with_program_interface("build/amm-phases/rust.so", true, interface);
    assert_eq!(bend.f.program, rust.f.program);
    assert_eq!(bend.f.state.pubkey(), rust.f.state.pubkey());
    assert_eq!(bend.f.custody, rust.f.custody);
    assert_eq!(bend.keys(), rust.keys());
    assert_eq!(bend.snapshot(), rust.snapshot());
    for amm in [&mut bend, &mut rust] {
        amm.f.send(&[amm.f.create(amm.f.state.pubkey(), amm.f.size, amm.f.program)])
            .unwrap();
    }
    let cases = [
        ("initialize", 0, [100_000, 400_000, 199_000], false, None, 3, 8),
        ("reject_zero_input", 3, [0, 0, 0], true, Some(260), 0, 5),
        ("reject_slippage", 3, [1_000, u64::MAX, 0], true, Some(261), 0, 5),
        ("swap_base", 3, [1_000, 1, 0], true, None, 2, 8),
    ];
    let mut rows = Vec::new();
    for (name, op, values, direction, error, token_cpis, reached) in cases {
        let bi = bend.instruction(op, values, direction);
        let ri = rust.instruction(op, values, direction);
        assert_eq!(bi.data, ri.data, "instruction bytes: {name}");
        assert_eq!(bi, ri, "account metadata: {name}");
        assert_eq!(bend.snapshot(), rust.snapshot(), "before {name}");
        let before = bend.snapshot();
        let br = bend.f.send(&[bi]);
        let rr = rust.f.send(&[ri]);
        let (bm, rm) = match error {
            None => (br.unwrap(), rr.unwrap()),
            Some(code) => {
                let b = br.unwrap_err();
                let r = rr.unwrap_err();
                assert_eq!(b.err, r.err, "rejection: {name}");
                assert_eq!(b.err,
                    TransactionError::InstructionError(0, InstructionError::Custom(code)));
                assert_eq!(bend.snapshot(), before, "Bend rollback: {name}");
                assert_eq!(rust.snapshot(), before, "Rust rollback: {name}");
                (b.meta, r.meta)
            }
        };
        assert_eq!(bend.snapshot(), rust.snapshot(), "after {name}");
        assert_eq!(bm.return_data, rm.return_data, "return data: {name}");
        let outcome = if error.is_some() { "failed" } else { "success" };
        let bend_invocations = benchmark_invocation_json(
            &bm.logs, bend.f.program, token_cpis, outcome, bm.compute_units_consumed);
        let rust_invocations = benchmark_invocation_json(
            &rm.logs, rust.f.program, token_cpis, outcome, rm.compute_units_consumed);
        let bend_readings = phase_readings(&bm.logs, reached);
        let rust_readings = phase_readings(&rm.logs, reached);
        rows.push(serde_json::json!({
            "operation": name,
            "error": error,
            "bend": {
                "readings": bend_readings,
                "intervals": phase_intervals(&bend_readings),
                "totalCU": bm.compute_units_consumed,
                "invocations": bend_invocations,
            },
            "rust": {
                "readings": rust_readings,
                "intervals": phase_intervals(&rust_readings),
                "totalCU": rm.compute_units_consumed,
                "invocations": rust_invocations,
            },
        }));
    }
    let report = serde_json::json!({
        "runtime": "LiteSVM 0.7.1",
        "target": "SBF v0 / generic",
        "fixture": "fixed public test seeds 1..12; program bytes [42;32]",
        "markers": PHASE_MARKERS,
        "measurement": "Remaining-CU readings from sol_log_compute_units_; each interval includes marker syscall overhead and compiled diagnostic code. Token Program child CU is inclusive in the parent interval and must not be added again. No overhead correction is claimed.",
        "boundaryDifferences": "accounts_parsed follows account parsing and initial instruction checks. parsed_pda follows the Token Program check, PDA derivation, and state owner/size/writable checks. decoded_clock follows state and instruction decoding and the clock syscall; Bend also constructs a context. transition follows the business call but precedes rejection mapping. validated follows state encoding, Bend effect extraction, and effect validation. token_executed follows the CPI loop. state_written precedes return-data publication. Marker locations reflect each implementation's control flow, not identical intrinsic operations.",
        "rows": rows,
    });
    let destination = "build/amm-phases/report.json";
    std::fs::write(format!("{destination}.tmp"),
        serde_json::to_string_pretty(&report).unwrap() + "\n").unwrap();
    std::fs::rename(format!("{destination}.tmp"), destination).unwrap();
    println!("AMM phase diagnostic: {report}");
}

#[test]
fn amm_adapter_rejects_malformed_accounts_and_encodings() {
    let mut a = Amm::new();
    a.initialize(10_000, 10_000, 9_000);
    let clean = a.f.svm.clone();
    for case in 0..33 {
        a.f.svm = clean.clone();
        let mut ix = a.instruction(3, [1000, 1, 0], true);
        if case >= 25 {
            ix = a.instruction(1, [1000, 1000, 1000], false);
        }
        let mut edit = |key: Pubkey, change: &dyn Fn(&mut Account)| {
            let mut account = a.f.svm.get_account(&key).unwrap();
            change(&mut account);
            a.f.svm.set_account(key, account).unwrap();
        };
        let code = match case {
            0 => {
                ix.accounts.truncate(3);
                1
            }
            1 => {
                ix.data[0] = 2;
                2
            }
            2 => {
                ix.data[1] = 4;
                2
            }
            3 => {
                ix.data[2] = 2;
                2
            }
            4 => {
                ix.data[194] = 1;
                2
            }
            5 => {
                edit(a.f.state.pubkey(), &|x| x.owner = spl_token::id());
                3
            }
            6 => {
                ix.accounts[0].is_writable = false;
                5
            }
            7 => {
                edit(a.f.state.pubkey(), &|x| {
                    x.data.pop();
                });
                4
            }
            8 => {
                edit(a.f.state.pubkey(), &|x| x.data[0] ^= 1);
                4
            }
            9 => {
                edit(a.f.state.pubkey(), &|x| x.data[21] = 1);
                4
            }
            10 => {
                ix.accounts[4].pubkey = ix.accounts[5].pubkey;
                6
            }
            11 => {
                ix.accounts[2].pubkey = a.f.attacker.pubkey();
                10
            }
            12 => {
                ix.accounts[3].pubkey = a.f.attacker.pubkey();
                11
            }
            13 => {
                edit(a.f.mint.pubkey(), &|x| x.owner = a.f.program);
                13
            }
            14 => {
                edit(a.f.mint.pubkey(), &|x| {
                    x.data.pop();
                });
                14
            }
            15 => {
                edit(a.f.mint.pubkey(), &|x| x.data[45] = 0);
                14
            }
            16 => {
                edit(a.f.user_token.pubkey(), &|x| x.owner = a.f.program);
                13
            }
            17 => {
                edit(a.f.user_token.pubkey(), &|x| {
                    x.data.pop();
                });
                14
            }
            18 => {
                edit(a.f.user_token.pubkey(), &|x| x.data[108] = 0);
                14
            }
            19 => {
                edit(a.f.user_token.pubkey(), &|x| x.data[109] = 1);
                14
            }
            20 => {
                edit(a.f.user_token.pubkey(), &|x| {
                    x.data[..32].copy_from_slice(a.quote.as_ref())
                });
                15
            }
            21 => {
                edit(a.f.user_token.pubkey(), &|x| {
                    x.data[32..64].copy_from_slice(a.f.attacker.pubkey().as_ref())
                });
                16
            }
            22 => {
                edit(a.user_quote, &|x| {
                    x.data[32..64].copy_from_slice(a.f.attacker.pubkey().as_ref())
                });
                17
            }
            23 => {
                ix.accounts[4].is_writable = false;
                5
            }
            24 => {
                ix.accounts[1].is_signer = false;
                257
            }
            25 => {
                edit(a.lp, &|x| x.data[46] = 1);
                23
            }
            26 => {
                edit(a.lp, &|x| x.data[0] = 0);
                23
            }
            27 => {
                edit(a.lp, &|x| {
                    x.data[4..36].copy_from_slice(a.f.actor.pubkey().as_ref())
                });
                23
            }
            28 => {
                edit(a.lp, &|x| x.owner = a.f.program);
                13
            }
            29 => {
                edit(a.lp, &|x| {
                    x.data.pop();
                });
                14
            }
            30 => {
                edit(a.user_lp, &|x| {
                    x.data[32..64].copy_from_slice(a.f.attacker.pubkey().as_ref())
                });
                17
            }
            31 => {
                edit(a.user_lp, &|x| {
                    x.data[..32].copy_from_slice(a.quote.as_ref())
                });
                15
            }
            32 => {
                ix.accounts[11].is_writable = false;
                5
            }
            _ => unreachable!(),
        };
        a.reject(ix, Some(code));
    }
}

#[test]
fn amm_initialization_rejects_reused_mints_and_unsafe_custody() {
    let mut a = Amm::new();
    a.f.send(&[a.f.create(a.f.state.pubkey(), a.f.size, a.f.program)])
        .unwrap();
    let clean = a.f.svm.clone();
    for case in 0..9 {
        a.f.svm = clean.clone();
        let mut ix = a.instruction(0, [10_000, 10_000, 9_000], false);
        let mut edit = |key: Pubkey, offset: usize, bytes: &[u8]| {
            let mut account = a.f.svm.get_account(&key).unwrap();
            account.data[offset..offset + bytes.len()].copy_from_slice(bytes);
            a.f.svm.set_account(key, account).unwrap();
        };
        let code = match case {
            0 => {
                edit(a.lp, 36, &1u64.to_le_bytes());
                24
            }
            1 => {
                edit(a.lp, 4, a.f.actor.pubkey().as_ref());
                23
            }
            2 => {
                edit(a.lp, 46, &1u32.to_le_bytes());
                23
            }
            3 => {
                edit(a.f.vault_token.pubkey(), 64, &1u64.to_le_bytes());
                26
            }
            4 => {
                edit(a.f.vault_token.pubkey(), 72, &1u32.to_le_bytes());
                26
            }
            5 => {
                edit(a.quote_vault, 129, &1u32.to_le_bytes());
                26
            }
            6 => {
                edit(a.quote_vault, 32, a.f.actor.pubkey().as_ref());
                26
            }
            7 => {
                ix.accounts[0].is_signer = false;
                7
            }
            8 => {
                edit(a.f.state.pubkey(), 215, &[1]);
                4
            }
            _ => unreachable!(),
        };
        a.reject(ix, Some(code));
    }
}
