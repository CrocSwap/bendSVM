//! Independent codec for the documented queue ABI.
use super::transition::{Key,Queue,State,Instruction,Obligation};
pub const INSTRUCTION_BYTES:usize=68;
pub const PAYLOAD_BYTES:usize=151;
pub const STATE_BYTES:usize=171;
pub const RECORD_BYTES:usize=43;
pub const HEADER:[u8;20]=[66, 68, 83, 49, 28, 144, 59, 166, 224, 103, 162, 65, 41, 140, 173, 211, 149, 183, 209, 213];
pub const COLLECTION_HEADER:[u8;20]=[66, 68, 67, 49, 206, 249, 9, 68, 59, 104, 210, 208, 62, 200, 147, 72, 222, 200, 142, 22];
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
    fn finished(&self)->bool{self.bytes[self.offset..].iter().all(|b|*b==0)}
}
pub fn instruction(bytes:&[u8])->Option<Instruction>{
 if bytes.len()!=INSTRUCTION_BYTES{return None;}let mut r=Reader{bytes,offset:0};if r.byte()?>1{return None;}
 let ix=match r.byte()? {
  0=>Instruction::Initialize{mint:r.key()?,vault:r.key()?},
  1=>Instruction::Append{recipient:r.key()?,amount:r.word()?},
  2=>Instruction::Seal,
  3=>Instruction::Settle{count:u32::from_le_bytes(r.take()?),fuel:r.natural()?},
  _=>return None,
 };r.finished().then_some(ix)
}
pub fn state(bytes:&[u8])->Option<State>{
 if bytes.len()!=STATE_BYTES||bytes[..20]!=HEADER{return None;}
 let mut r=Reader{bytes,offset:20};let tag=r.byte()?;
 let state=match tag {
  0=>State::Empty,3=>State::Closed,
  1|2=>{r.tag()?;let q=Queue{owner:r.key()?,mint:r.key()?,vault:r.key()?,collection:r.key()?,count:u32::from_le_bytes(r.take()?),cursor:u32::from_le_bytes(r.take()?),remaining:r.word()?};if tag==1{State::Collecting(q)}else{State::Paying(q)}},
  _=>return None,
 };r.finished().then_some(state)
}
pub fn record(bytes:&[u8])->Option<Obligation>{
 if bytes.len()!=RECORD_BYTES{return None;}let mut r=Reader{bytes,offset:0};r.tag()?;
 let value=Obligation{recipient:r.key()?,amount:r.word()?};r.finished().then_some(value)
}
pub fn encode_record(value:Obligation)->[u8;RECORD_BYTES]{
 let mut bytes=[0;RECORD_BYTES];bytes[2..34].copy_from_slice(&value.recipient);bytes[35..43].copy_from_slice(&value.amount.to_le_bytes());bytes
}
pub fn payload(state:State)->[u8;PAYLOAD_BYTES]{
 let mut bytes=[0;PAYLOAD_BYTES];let (tag,q)=match state {
  State::Empty=>return bytes,State::Closed=>{bytes[0]=3;return bytes;},State::Collecting(q)=>(1,q),State::Paying(q)=>(2,q),
 };bytes[0]=tag;
 for (i,key) in [q.owner,q.mint,q.vault,q.collection].iter().enumerate(){bytes[3+i*33..35+i*33].copy_from_slice(key);}
 bytes[134..138].copy_from_slice(&q.count.to_le_bytes());bytes[138..142].copy_from_slice(&q.cursor.to_le_bytes());bytes[143..151].copy_from_slice(&q.remaining.to_le_bytes());bytes
}
