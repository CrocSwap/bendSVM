//! Shared oracle vectors establish arithmetic conformance before we compare
//! complete programs. These host tests are not SBF performance measurements.
#[path = "../benchmarks/amm-rust/pricing.rs"]
mod pricing;

use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    input: Vec<u8>,
    expected: Vec<u8>,
}

fn word(bytes: &[u8]) -> u64 {
    assert_eq!(bytes.len(), 9);
    assert_eq!(bytes[0], 0);
    u64::from_le_bytes(bytes[1..].try_into().unwrap())
}

fn encode_word(value: u64) -> Vec<u8> {
    let mut out = vec![0];
    out.extend_from_slice(&value.to_le_bytes());
    out
}

fn encode_result(value: pricing::Checked) -> Vec<u8> {
    match value {
        Ok(value) => {
            let mut out = vec![0];
            out.extend_from_slice(&encode_word(value));
            out
        }
        Err(code) => {
            let mut out = vec![1];
            out.extend_from_slice(&code.to_le_bytes());
            out.resize(10, 0);
            out
        }
    }
}

#[test]
fn rust_amm_pricing_matches_shared_oracle() {
    let cases: Vec<Case> = serde_json::from_slice(
        &std::fs::read("build/amm-pricing-vectors.json").expect("run bun tests/amm-pricing.ts"),
    )
    .unwrap();
    assert!(cases.len() >= 588);
    for case in cases {
        let opcode = case.input[0];
        assert_eq!(case.input.len(), if opcode == 0 { 10 } else { 28 });
        let a = word(&case.input[1..10]);
        let result = if opcode == 0 {
            pricing::fee(a)
        } else {
            let b = word(&case.input[10..19]);
            let c = word(&case.input[19..28]);
            match opcode {
                1 => pricing::swap(a, b, c),
                2 => pricing::deposit(a, b, c),
                3 => pricing::withdraw(a, b, c),
                _ => panic!("unknown operation"),
            }
        };
        assert_eq!(encode_result(result), case.expected, "{}", case.name);
    }
}

#[test]
fn rust_sqrt_matches_shared_oracle() {
    let cases: Vec<Case> = serde_json::from_slice(
        &std::fs::read("build/sqrt-vectors.json").expect("run bun tests/sqrt.ts"),
    )
    .unwrap();
    assert!(cases.len() >= 111);
    for case in cases {
        let result = match case.input[0] {
            0 => {
                assert_eq!(case.input.len(), 20);
                assert_eq!(case.input[1], 0);
                let low = word(&case.input[2..11]);
                let high = word(&case.input[11..20]);
                pricing::sqrt(u128::from(low) | (u128::from(high) << 64))
            }
            1 => {
                assert_eq!(case.input.len(), 19);
                pricing::geometric_mean(word(&case.input[1..10]), word(&case.input[10..19]))
            }
            _ => panic!("unknown operation"),
        };
        assert_eq!(encode_word(result), case.expected, "{}", case.name);
    }
}

#[path = "../benchmarks/amm-rust/transition.rs"]
mod transition;

#[path = "../benchmarks/amm-rust/wire.rs"]
mod wire;

#[test]
fn rust_amm_wire_matches_public_client_and_rejects_noncanonical_data() {
    use transition::{Config, Instruction, Pool, State};
    let vectors: Vec<serde_json::Value> = serde_json::from_slice(
        &std::fs::read("build/amm-client-vectors.json").expect("run bun tests/amm.ts"),
    )
    .unwrap();
    let config = Config {
        base: [7; 32],
        quote: [10; 32],
        lp: [12; 32],
        base_vault: [6; 32],
        quote_vault: [9; 32],
    };
    let expected = [
        (
            0,
            Instruction::Initialize {
                config,
                base: 10000,
                quote: 40000,
                min_shares: 19000,
            },
        ),
        (
            1,
            Instruction::Deposit {
                shares: 100,
                max_base: 100,
                max_quote: 400,
            },
        ),
        (
            1,
            Instruction::Withdraw {
                shares: 100,
                min_base: 50,
                min_quote: 200,
            },
        ),
        (
            1,
            Instruction::Swap {
                base_in: true,
                amount: 1000,
                min_output: 906,
            },
        ),
    ];
    assert_eq!(vectors.len(), expected.len());
    for (vector, expected) in vectors.iter().zip(expected) {
        let bytes: Vec<u8> = serde_json::from_value(vector["data"].clone()).unwrap();
        assert_eq!(wire::instruction(&bytes), Some(expected));
        for length in 0..bytes.len() {
            assert!(wire::instruction(&bytes[..length]).is_none());
        }
        let mut bad = bytes.clone();
        bad[0] = 2;
        assert!(wire::instruction(&bad).is_none());
        bad = bytes.clone();
        bad[1] = 4;
        assert!(wire::instruction(&bad).is_none());
        if bytes[1] != 0 {
            bad = bytes.clone();
            bad[194] = 1;
            assert!(wire::instruction(&bad).is_none());
        }
        if bytes[1] == 3 {
            bad = bytes.clone();
            bad[2] = 2;
            assert!(wire::instruction(&bad).is_none());
        }
    }
    for state in [
        State::Empty,
        State::Open(Pool {
            config,
            base: u64::MAX,
            quote: 1,
            shares: 1000,
        }),
    ] {
        let mut bytes = wire::HEADER.to_vec();
        bytes.extend_from_slice(&wire::payload(state));
        assert_eq!(bytes.len(), wire::STATE_BYTES);
        assert_eq!(wire::state(&bytes), Some(state));
        for offset in [0, 19, 20, 21, 22, 23, 56, 89, 122, 155, 188, 189, 198, 207] {
            let mut bad = bytes.clone();
            bad[offset] = 255;
            assert!(
                wire::state(&bad).is_none(),
                "accepted corrupt byte {offset}"
            );
        }
    }
}

#[test]
fn rust_amm_transition_lifecycle_and_policies() {
    use transition::{process, Config, Effect, Instruction, Pool, State};
    let config = Config {
        base: [1; 32],
        quote: [2; 32],
        lp: [3; 32],
        base_vault: [4; 32],
        quote_vault: [5; 32],
    };
    let initialize = Instruction::Initialize {
        config,
        base: 10_000,
        quote: 10_000,
        min_shares: 9000,
    };
    assert_eq!(process(false, State::Empty, initialize), Err(1));
    let (state, effects) = process(true, State::Empty, initialize).unwrap();
    assert_eq!(
        state,
        State::Open(Pool {
            config,
            base: 10_000,
            quote: 10_000,
            shares: 10_000
        })
    );
    assert_eq!(
        effects[2],
        Effect::Mint {
            destination: 10,
            mint: 11,
            mint_key: config.lp,
            amount: 9000,
            initialize: true
        }
    );
    assert_eq!(process(true, state, initialize), Err(2));
    let (state, _) = process(
        true,
        state,
        Instruction::Deposit {
            shares: 5000,
            max_base: 5000,
            max_quote: 5000,
        },
    )
    .unwrap();
    let (state, _) = process(
        true,
        state,
        Instruction::Swap {
            base_in: true,
            amount: 1000,
            min_output: 0,
        },
    )
    .unwrap();
    let State::Open(pool) = state else {
        panic!("expected open pool")
    };
    let output = (15_000u128 * 997 / 15_997) as u64;
    assert_eq!(
        (pool.base, pool.quote, pool.shares),
        (16_000, 15_000 - output, 15_000)
    );
    assert_eq!(
        process(
            true,
            state,
            Instruction::Withdraw {
                shares: 14_001,
                min_base: 0,
                min_quote: 0
            }
        ),
        Err(6)
    );
    assert_eq!(
        process(
            true,
            state,
            Instruction::Swap {
                base_in: false,
                amount: 1000,
                min_output: u64::MAX
            }
        ),
        Err(5)
    );
    let (state, effects) = process(
        true,
        state,
        Instruction::Withdraw {
            shares: 14_000,
            min_base: 0,
            min_quote: 0,
        },
    )
    .unwrap();
    assert_eq!(
        effects[0],
        Effect::Burn {
            source: 10,
            mint: 11,
            mint_key: config.lp,
            amount: 14_000
        }
    );
    let State::Open(pool) = state else {
        panic!("expected open pool")
    };
    assert_eq!(pool.shares, 1000);
    assert!(pool.base > 0 && pool.quote > 0);
}
