//! Independent queue protocol using native arrays and checked integer arithmetic.
pub type Key = [u8;32];
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Authority {
    Actor,
    Custody,
}
#[derive(Clone, Copy)]
pub enum Effect {
    None,
    Transfer {
        source: usize,
        destination: usize,
        mint: usize,
        mint_key: Key,
        recipient: Option<Key>,
        amount: u64,
        authority: Authority,
        source_key: Option<Key>,
        destination_key: Option<Key>,
    },
}
#[derive(Clone,Copy)]
pub struct Obligation {pub recipient:Key,pub amount:u64}
#[derive(Clone,Copy)]
pub struct Queue {pub owner:Key,pub mint:Key,pub vault:Key,pub collection:Key,pub count:u32,pub cursor:u32,pub remaining:u64}
#[derive(Clone,Copy)]
pub enum State {Empty,Collecting(Queue),Paying(Queue),Closed}
#[derive(Clone,Copy)]
pub enum Instruction {Initialize{mint:Key,vault:Key},Append{recipient:Key,amount:u64},Seal,Settle{count:u32,fuel:u32}}
#[derive(Clone,Copy)]
pub struct Metadata {pub length:u32,pub capacity:u32}
#[derive(Clone,Copy)]
pub struct Window {pub start:u32,pub length:u32,pub items:[Obligation;2]}

pub fn select(state:State,ix:Instruction,meta:Metadata)->Result<(u32,u32),u64>{
 let (start,count,limit)=match ix {
  Instruction::Append{..}=>(meta.length,1,meta.capacity),
  Instruction::Settle{count,..}=>(if let State::Paying(q)=state{q.cursor}else{0},count,meta.length),
  _=>(0,0,meta.length),
 };
 if meta.length>meta.capacity||start>meta.length||count>2||u64::from(start)+u64::from(count)>u64::from(limit){return Err(23);}
 Ok((start,count))
}
pub fn process(signed:bool,actor:Key,collection:Key,state:State,ix:Instruction,meta:Metadata,mut window:Window)->Result<(State,Window,u32,[Effect;2]),u32>{
 let none=[Effect::None;2];
 let (mut q,collecting)=match state {
  State::Empty=>return match ix {
   Instruction::Initialize{mint,vault}=>if signed&&meta.length==0 {
    Ok((State::Collecting(Queue{owner:actor,mint,vault,collection,count:0,cursor:0,remaining:0}),window,0,none))
   }else{Err(1)},
   _=>Err(2),
  },
  State::Closed=>return Err(2),
  State::Collecting(q)=>(q,true),State::Paying(q)=>(q,false),
 };
 if !signed||actor!=q.owner||collection!=q.collection{return Err(1);}
 match (collecting,ix) {
  (true,Instruction::Append{recipient,amount})=>{
   if amount==0||q.count!=meta.length||meta.length>=meta.capacity||window.start!=meta.length||window.length!=0{return Err(3);}
   q.remaining=q.remaining.checked_add(amount).ok_or(4u32)?;q.count+=1;
   window.items[0]=Obligation{recipient,amount};window.length=1;
   let effect=Effect::Transfer{source:5,destination:6,mint:7,mint_key:q.mint,recipient:None,amount,authority:Authority::Actor,source_key:None,destination_key:Some(q.vault)};
   Ok((State::Collecting(q),window,q.count,[effect,Effect::None]))
  },
  (true,Instruction::Seal)=>{
   if q.count==0||q.count!=meta.length{return Err(3);}
   Ok((State::Paying(q),window,meta.length,none))
  },
  (false,Instruction::Settle{count,fuel})=>{
   if q.count!=meta.length||window.start!=q.cursor||window.length!=count||count==0||count>2||u64::from(q.cursor)+u64::from(count)>u64::from(q.count){return Err(3);}
   if fuel!=count{return Err(5);}
   let mut effects=none;
   for i in 0..count as usize{
    let obligation=window.items[i];q.remaining=q.remaining.checked_sub(obligation.amount).ok_or(4u32)?;
    effects[i]=Effect::Transfer{source:5,destination:7+i,mint:6,mint_key:q.mint,recipient:Some(obligation.recipient),amount:obligation.amount,authority:Authority::Custody,source_key:Some(q.vault),destination_key:None};
   }
   q.cursor+=count;let last=q.cursor==q.count;
   if last!=(q.remaining==0){return Err(6);}
   Ok((if last{State::Closed}else{State::Paying(q)},window,q.count,effects))
  },
  _=>Err(2),
 }
}
