//! Independent Rust expression of the documented pool protocol.
//! The SBF adapter validates accounts and executes these effects only after
//! the complete transition succeeds. No generated Bend implementation is used.
use super::pricing;

pub type Key = [u8; 32];
const LOCKED: u64 = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    pub base: Key,
    pub quote: Key,
    pub lp: Key,
    pub base_vault: Key,
    pub quote_vault: Key,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pool {
    pub config: Config,
    pub base: u64,
    pub quote: u64,
    pub shares: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Empty,
    Open(Pool),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Instruction {
    Initialize {
        config: Config,
        base: u64,
        quote: u64,
        min_shares: u64,
    },
    Deposit {
        shares: u64,
        max_base: u64,
        max_quote: u64,
    },
    Withdraw {
        shares: u64,
        min_base: u64,
        min_quote: u64,
    },
    Swap {
        base_in: bool,
        amount: u64,
        min_output: u64,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authority {
    Actor,
    Custody,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    None,
    Transfer {
        source: usize,
        destination: usize,
        mint: usize,
        mint_key: Key,
        recipient: Authority,
        amount: u64,
        authority: Authority,
        source_key: Option<Key>,
        destination_key: Option<Key>,
        fresh_destination: bool,
    },
    Mint {
        destination: usize,
        mint: usize,
        mint_key: Key,
        amount: u64,
        initialize: bool,
    },
    Burn {
        source: usize,
        mint: usize,
        mint_key: Key,
        amount: u64,
    },
}
pub type Outcome = Result<(State, [Effect; 3]), u32>;

fn transfer(config: Config, base: bool, incoming: bool, amount: u64, fresh: bool) -> Effect {
    let (user, reserve, mint, mint_key, vault) = if base {
        (4, 5, 6, config.base, config.base_vault)
    } else {
        (7, 8, 9, config.quote, config.quote_vault)
    };
    Effect::Transfer {
        source: if incoming { user } else { reserve },
        destination: if incoming { reserve } else { user },
        mint,
        mint_key,
        amount,
        recipient: if incoming {
            Authority::Custody
        } else {
            Authority::Actor
        },
        authority: if incoming {
            Authority::Actor
        } else {
            Authority::Custody
        },
        source_key: if incoming { None } else { Some(vault) },
        destination_key: if incoming { Some(vault) } else { None },
        fresh_destination: fresh,
    }
}
fn funding(config: Config, x: u64, y: u64, shares: u64, initialize: bool) -> [Effect; 3] {
    [
        transfer(config, true, true, x, initialize),
        transfer(config, false, true, y, initialize),
        Effect::Mint {
            destination: 10,
            mint: 11,
            mint_key: config.lp,
            amount: shares,
            initialize,
        },
    ]
}
fn checked(value: Option<u64>) -> Result<u64, u32> {
    value.ok_or(4)
}
fn price(value: pricing::Checked) -> Result<u64, u32> {
    value.map_err(|_| 4)
}

pub fn process(signed: bool, state: State, instruction: Instruction) -> Outcome {
    if !signed {
        return Err(1);
    }
    match (state, instruction) {
        (
            State::Empty,
            Instruction::Initialize {
                config,
                base,
                quote,
                min_shares,
            },
        ) => {
            if base == 0
                || quote == 0
                || config.base == config.quote
                || config.base == config.lp
                || config.quote == config.lp
                || config.base_vault == config.quote_vault
            {
                return Err(3);
            }
            let shares = pricing::geometric_mean(base, quote);
            let issued = checked(shares.checked_sub(LOCKED))?;
            if issued == 0 {
                return Err(4);
            }
            if issued < min_shares {
                return Err(5);
            }
            Ok((
                State::Open(Pool {
                    config,
                    base,
                    quote,
                    shares,
                }),
                funding(config, base, quote, issued, true),
            ))
        }
        (
            State::Open(pool),
            Instruction::Deposit {
                shares,
                max_base,
                max_quote,
            },
        ) => {
            let x = price(pricing::deposit(pool.base, shares, pool.shares))?;
            let y = price(pricing::deposit(pool.quote, shares, pool.shares))?;
            if x > max_base || y > max_quote {
                return Err(5);
            }
            let next = Pool {
                base: checked(pool.base.checked_add(x))?,
                quote: checked(pool.quote.checked_add(y))?,
                shares: checked(pool.shares.checked_add(shares))?,
                ..pool
            };
            Ok((State::Open(next), funding(pool.config, x, y, shares, false)))
        }
        (
            State::Open(pool),
            Instruction::Withdraw {
                shares,
                min_base,
                min_quote,
            },
        ) => {
            let available = pool.shares.checked_sub(LOCKED).ok_or(6u32)?;
            if shares == 0 || shares > available {
                return Err(6);
            }
            let x = price(pricing::withdraw(pool.base, shares, pool.shares))?;
            let y = price(pricing::withdraw(pool.quote, shares, pool.shares))?;
            if x < min_base || y < min_quote {
                return Err(5);
            }
            let next = Pool {
                base: checked(pool.base.checked_sub(x))?,
                quote: checked(pool.quote.checked_sub(y))?,
                shares: checked(pool.shares.checked_sub(shares))?,
                ..pool
            };
            Ok((
                State::Open(next),
                [
                    Effect::Burn {
                        source: 10,
                        mint: 11,
                        mint_key: pool.config.lp,
                        amount: shares,
                    },
                    transfer(pool.config, true, false, x, false),
                    transfer(pool.config, false, false, y, false),
                ],
            ))
        }
        (
            State::Open(pool),
            Instruction::Swap {
                base_in,
                amount,
                min_output,
            },
        ) => {
            let (input, output) = if base_in {
                (pool.base, pool.quote)
            } else {
                (pool.quote, pool.base)
            };
            let received = price(pricing::swap(input, output, amount))?;
            if received < min_output {
                return Err(5);
            }
            let new_input = checked(input.checked_add(amount))?;
            let new_output = checked(output.checked_sub(received))?;
            let next = Pool {
                base: if base_in { new_input } else { new_output },
                quote: if base_in { new_output } else { new_input },
                ..pool
            };
            Ok((
                State::Open(next),
                [
                    transfer(pool.config, base_in, true, amount, false),
                    transfer(pool.config, !base_in, false, received, false),
                    Effect::None,
                ],
            ))
        }
        _ => Err(2),
    }
}
