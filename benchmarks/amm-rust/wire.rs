//! Independent implementation of the published AMM wire layout.
//! Fixed-size values require zero padding and canonical constructor tags.
use super::transition::{Config, Instruction, Key, Pool, State};

pub const INSTRUCTION_BYTES: usize = 195;
pub const PAYLOAD_BYTES: usize = 196;
pub const STATE_BYTES: usize = 216;
pub const HEADER: [u8; 20] = [
    66, 68, 83, 49, 188, 148, 18, 135, 113, 113, 213, 246, 37, 79, 12, 140, 208, 122, 18, 15,
];

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> Reader<'a> {
    fn byte(&mut self) -> Option<u8> {
        let byte = *self.bytes.get(self.offset)?;
        self.offset += 1;
        Some(byte)
    }
    fn tag(&mut self) -> Option<()> {
        (self.byte()? == 0).then_some(())
    }
    fn key(&mut self) -> Option<Key> {
        self.tag()?;
        let key = self
            .bytes
            .get(self.offset..self.offset + 32)?
            .try_into()
            .ok()?;
        self.offset += 32;
        Some(key)
    }
    fn word(&mut self) -> Option<u64> {
        self.tag()?;
        let bytes = self
            .bytes
            .get(self.offset..self.offset + 8)?
            .try_into()
            .ok()?;
        self.offset += 8;
        Some(u64::from_le_bytes(bytes))
    }
    fn config(&mut self) -> Option<Config> {
        self.tag()?;
        Some(Config {
            base: self.key()?,
            quote: self.key()?,
            lp: self.key()?,
            base_vault: self.key()?,
            quote_vault: self.key()?,
        })
    }
    fn finished(&self) -> bool {
        self.bytes[self.offset..].iter().all(|byte| *byte == 0)
    }
}

pub fn instruction(bytes: &[u8]) -> Option<(u8, Instruction)> {
    if bytes.len() != INSTRUCTION_BYTES {
        return None;
    }
    let mut r = Reader { bytes, offset: 0 };
    let mode = r.byte()?;
    if mode > 1 {
        return None;
    }
    let instruction = match r.byte()? {
        0 => Instruction::Initialize {
            config: r.config()?,
            base: r.word()?,
            quote: r.word()?,
            min_shares: r.word()?,
        },
        1 => Instruction::Deposit {
            shares: r.word()?,
            max_base: r.word()?,
            max_quote: r.word()?,
        },
        2 => Instruction::Withdraw {
            shares: r.word()?,
            min_base: r.word()?,
            min_quote: r.word()?,
        },
        3 => {
            let base_in = match r.byte()? {
                0 => false,
                1 => true,
                _ => return None,
            };
            Instruction::Swap {
                base_in,
                amount: r.word()?,
                min_output: r.word()?,
            }
        }
        _ => return None,
    };
    r.finished().then_some((mode, instruction))
}

pub fn state(bytes: &[u8]) -> Option<State> {
    if bytes.len() != STATE_BYTES || bytes[..20] != HEADER {
        return None;
    }
    let mut r = Reader {
        bytes: &bytes[20..],
        offset: 0,
    };
    let state = match r.byte()? {
        0 => State::Empty,
        1 => {
            r.tag()?; // Pool
            let config = r.config()?;
            r.tag()?; // Balances
            State::Open(Pool {
                config,
                base: r.word()?,
                quote: r.word()?,
                shares: r.word()?,
            })
        }
        _ => return None,
    };
    r.finished().then_some(state)
}

pub fn payload(state: State) -> [u8; PAYLOAD_BYTES] {
    let mut bytes = [0; PAYLOAD_BYTES];
    if let State::Open(pool) = state {
        bytes[0] = 1;
        for (i, key) in [
            pool.config.base,
            pool.config.quote,
            pool.config.lp,
            pool.config.base_vault,
            pool.config.quote_vault,
        ]
        .iter()
        .enumerate()
        {
            bytes[4 + i * 33..36 + i * 33].copy_from_slice(key);
        }
        for (i, value) in [pool.base, pool.quote, pool.shares].iter().enumerate() {
            bytes[170 + i * 9..178 + i * 9].copy_from_slice(&value.to_le_bytes());
        }
    }
    bytes
}
