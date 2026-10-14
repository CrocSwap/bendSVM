//! Independent canonical codec for the published batch wire format.
use super::transition::{Batch, Instruction, Key, Obligation, State};
pub const INSTRUCTION_BYTES: usize = 252;
pub const PAYLOAD_BYTES: usize = 294;
pub const STATE_BYTES: usize = 314;
pub const HEADER: [u8; 20] = [
    66, 68, 83, 49, 61, 40, 230, 94, 191, 136, 107, 169, 217, 182, 51, 93, 227, 47, 69, 244,
];
struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> Reader<'a> {
    fn byte(&mut self) -> Option<u8> {
        let b = *self.bytes.get(self.offset)?;
        self.offset += 1;
        Some(b)
    }
    fn tag(&mut self) -> Option<()> {
        (self.byte()? == 0).then_some(())
    }
    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let b = self
            .bytes
            .get(self.offset..self.offset + N)?
            .try_into()
            .ok()?;
        self.offset += N;
        Some(b)
    }
    fn key(&mut self) -> Option<Key> {
        self.tag()?;
        self.take()
    }
    fn word(&mut self) -> Option<u64> {
        self.tag()?;
        Some(u64::from_le_bytes(self.take()?))
    }
    fn natural(&mut self) -> Option<u32> {
        let n = u32::from_le_bytes(self.take()?);
        (n <= 64).then_some(n)
    }
    fn vector(&mut self) -> Option<(u32, [Obligation; 4])> {
        self.tag()?;
        let length = u32::from_le_bytes(self.take()?);
        self.tag()?;
        let mut values = [Obligation {
            recipient: [0; 32],
            amount: 0,
        }; 4];
        for (i, value) in values.iter_mut().enumerate() {
            if i % 2 == 0 {
                self.tag()?;
            }
            self.tag()?;
            *value = Obligation {
                recipient: self.key()?,
                amount: self.word()?,
            };
        }
        Some((length, values))
    }
    fn finished(&self) -> bool {
        self.bytes[self.offset..].iter().all(|b| *b == 0)
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
        0 => {
            let mint = r.key()?;
            let vault = r.key()?;
            let (length, obligations) = r.vector()?;
            let fuel = r.natural()?;
            Instruction::Initialize {
                mint,
                vault,
                length,
                obligations,
                fuel,
            }
        }
        1 => Instruction::Settle,
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
            r.tag()?;
            let owner = r.key()?;
            let mint = r.key()?;
            let vault = r.key()?;
            let (length, obligations) = r.vector()?;
            let fuel = r.natural()?;
            let total = r.word()?;
            State::Funded(Batch {
                owner,
                mint,
                vault,
                length,
                obligations,
                fuel,
                total,
            })
        }
        2 => State::Closed,
        _ => return None,
    };
    r.finished().then_some(state)
}
struct Writer {
    bytes: [u8; PAYLOAD_BYTES],
    offset: usize,
}
impl Writer {
    fn byte(&mut self, b: u8) {
        self.bytes[self.offset] = b;
        self.offset += 1;
    }
    fn raw(&mut self, b: &[u8]) {
        self.bytes[self.offset..self.offset + b.len()].copy_from_slice(b);
        self.offset += b.len();
    }
    fn key(&mut self, k: Key) {
        self.byte(0);
        self.raw(&k);
    }
    fn word(&mut self, n: u64) {
        self.byte(0);
        self.raw(&n.to_le_bytes());
    }
}
pub fn payload(state: State) -> [u8; PAYLOAD_BYTES] {
    let mut w = Writer {
        bytes: [0; PAYLOAD_BYTES],
        offset: 0,
    };
    match state {
        State::Empty => {}
        State::Closed => w.byte(2),
        State::Funded(b) => {
            w.byte(1);
            w.byte(0);
            w.key(b.owner);
            w.key(b.mint);
            w.key(b.vault);
            w.byte(0);
            w.raw(&b.length.to_le_bytes());
            w.byte(0);
            for (i, obligation) in b.obligations.iter().enumerate() {
                if i % 2 == 0 {
                    w.byte(0);
                }
                w.byte(0);
                w.key(obligation.recipient);
                w.word(obligation.amount);
            }
            w.raw(&b.fuel.to_le_bytes());
            w.word(b.total);
        }
    }
    w.bytes
}
