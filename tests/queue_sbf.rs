use super::*;
use super::token_fixture::TokenFixture;
use solana_program_pack::Pack;
use spl_token::{instruction as token,state::Account as TokenAccount};

struct QueueFixture {
    f:TokenFixture,
    collection:Keypair,
    owners:[Pubkey;2],
    destinations:[Pubkey;2],
}
impl QueueFixture {
    fn new(capacity:usize)->Self {
        let elf=std::env::var("QUEUE_PROGRAM").unwrap_or_else(|_|"build/queue.so".into());
        let mut f=TokenFixture::with_program_seeded("queue",&elf,true);let collection=Keypair::new_from_array([10;32]);
        let owners=[Pubkey::new_from_array([100;32]),Pubkey::new_from_array([101;32])];
        let destinations=std::array::from_fn(|i| {
            let key=Keypair::new_from_array([20+i as u8;32]);let ixs=[f.create(key.pubkey(),TokenAccount::LEN,spl_token::id()),
              token::initialize_account3(&spl_token::id(),&key.pubkey(),&f.mint.pubkey(),&owners[i]).unwrap()];
            f.send_extra(&ixs,&[&key]).unwrap();key.pubkey()
        });
        let mut q=Self{f,collection,owners,destinations};
        let ix=q.initialize();let setup=[q.f.create(q.f.state.pubkey(),q.f.size,q.f.program),
            q.f.create(q.collection.pubkey(),56+43*capacity,q.f.program),ix];
        q.f.send_extra(&setup,&[&q.collection]).unwrap();q.f.max_cu=0;q
    }
    fn prefix(&self,init:bool)->Vec<AccountMeta>{vec![
      AccountMeta::new(self.f.state.pubkey(),init),AccountMeta::new_readonly(self.f.actor.pubkey(),true),
      AccountMeta::new_readonly(spl_token::id(),false),AccountMeta::new_readonly(self.f.custody,false),
      AccountMeta::new(self.collection.pubkey(),init)]}
    fn ix(&self,accounts:Vec<AccountMeta>,mut data:Vec<u8>)->Instruction {
        data.resize(68,0);Instruction{program_id:self.f.program,accounts,data}
    }
    fn initialize(&self)->Instruction {
        let mut data=vec![0,0];for key in [self.f.mint.pubkey(),self.f.vault_token.pubkey()]{data.push(0);data.extend_from_slice(key.as_ref());}
        self.ix(self.prefix(true),data)
    }
    fn append(&self,recipient:usize,amount:u64)->Instruction {
        let mut data=vec![1,1,0];data.extend_from_slice(self.owners[recipient].as_ref());data.push(0);data.extend_from_slice(&amount.to_le_bytes());
        let mut accounts=self.prefix(false);accounts.extend([
            AccountMeta::new(self.f.user_token.pubkey(),false),AccountMeta::new(self.f.vault_token.pubkey(),false),
            AccountMeta::new_readonly(self.f.mint.pubkey(),false)]);self.ix(accounts,data)
    }
    fn seal(&self)->Instruction{self.ix(self.prefix(false),vec![1,2])}
    fn settle(&self,start:usize,count:u32,fuel:u32)->Instruction {
        let mut data=vec![1,3];data.extend_from_slice(&count.to_le_bytes());data.extend_from_slice(&fuel.to_le_bytes());
        let mut accounts=self.prefix(false);accounts.extend([AccountMeta::new(self.f.vault_token.pubkey(),false),AccountMeta::new_readonly(self.f.mint.pubkey(),false)]);
        for i in 0..count.min(2) as usize{accounts.push(AccountMeta::new(self.destinations[(start+i)%2],false));}
        self.ix(accounts,data)
    }
    fn collection_bytes(&self)->Vec<u8>{self.f.svm.get_account(&self.collection.pubkey()).unwrap().data}
    fn state(&self)->Vec<u8>{self.f.svm.get_account(&self.f.state.pubkey()).unwrap().data}
    fn snapshot(&self)->Vec<Option<Account>>{
        let mut result=self.f.snapshot();for key in [self.collection.pubkey(),self.destinations[0],self.destinations[1]]{result.push(self.f.svm.get_account(&key));}result
    }
    fn reject(&mut self,ix:Instruction,code:u32)->u64{
        let before=self.snapshot();let err=self.f.send(&[ix]).unwrap_err();
        assert_eq!(err.err,TransactionError::InstructionError(0,InstructionError::Custom(code)),"{:?}",err.meta.logs);
        assert_eq!(self.snapshot(),before);err.meta.compute_units_consumed
    }
    fn destination_balance(&self,i:usize)->u64{TokenAccount::unpack(&self.f.svm.get_account(&self.destinations[i]).unwrap().data).unwrap().amount}
}

#[test]
fn queue_large_collection_funds_and_settles_across_transactions(){
    let mut q=QueueFixture::new(256);let mut expected=[0u64;2];
    for i in 0..65 {let amount=(i%3+1) as u64;let ix=q.append(i%2,amount);q.f.send(&[ix]).unwrap();expected[i%2]+=amount;}
    let total=expected.iter().sum::<u64>();assert_eq!(q.f.balances(),(1000-total,total));
    let bytes=q.collection_bytes();assert_eq!(bytes.len(),11064);assert_eq!(u32::from_le_bytes(bytes[20..24].try_into().unwrap()),65);
    let ix=q.seal();q.f.send(&[ix]).unwrap();let ix=q.append(0,1);q.reject(ix,258);
    for start in (0..65).step_by(2) {
        let count=(65-start).min(2) as u32;let ix=q.settle(start,count,count);q.f.send(&[ix]).unwrap();
        assert_eq!(q.collection_bytes(),bytes);
        let state=q.state();if start+(count as usize)<65 {assert_eq!(u32::from_le_bytes(state[158..162].try_into().unwrap()),start as u32+count);}
    }
    assert_eq!(q.state()[20],3);assert_eq!(q.f.balances(),(1000-total,0));
    assert_eq!([q.destination_balance(0),q.destination_balance(1)],expected);
    let ix=q.settle(0,1,1);q.reject(ix,258);
}

#[test]
fn queue_guards_and_late_token_failure_preserve_all_accounts(){
    let mut q=QueueFixture::new(32);let ix=q.seal();q.reject(ix,259);
    let ix=q.append(0,0);q.reject(ix,259);
    let mut ix=q.append(0,1);ix.accounts[1].is_signer=false;q.reject(ix,257);
    let mut ix=q.append(0,1);ix.accounts[1].pubkey=q.f.attacker.pubkey();q.reject(ix,257);
    let ix=q.append(0,2000);q.reject(ix,1);
    for i in 0..2 {let ix=q.append(i,17+i as u64);q.f.send(&[ix]).unwrap();}
    let ix=q.seal();q.f.send(&[ix]).unwrap();
    let ix=q.settle(0,0,0);q.reject(ix,259);let ix=q.settle(0,2,1);q.reject(ix,261);
    let freeze=token::freeze_account(&spl_token::id(),&q.destinations[1],&q.f.mint.pubkey(),&q.f.actor.pubkey(),&[]).unwrap();q.f.send(&[freeze]).unwrap();
    let ix=q.settle(0,2,2);q.reject(ix,17);
    assert_eq!(q.destination_balance(0),0);assert_eq!(q.f.balances(),(965,35));
    let thaw=token::thaw_account(&spl_token::id(),&q.destinations[1],&q.f.mint.pubkey(),&q.f.actor.pubkey(),&[]).unwrap();q.f.send(&[thaw]).unwrap();
    let ix=q.settle(0,1,1);q.f.send(&[ix]).unwrap();let ix=q.settle(1,1,1);q.f.send(&[ix]).unwrap();
    assert_eq!([q.destination_balance(0),q.destination_balance(1)],[17,18]);
}

#[test]
fn queue_bindings_conservation_and_capacity_are_enforced(){
    let mut q=QueueFixture::new(2);
    for i in 0..2 {let ix=q.append(i,17+i as u64);q.f.send(&[ix]).unwrap();}
    let ix=q.append(0,1);q.reject(ix,23);
    let ix=q.seal();q.f.send(&[ix]).unwrap();
    let mut ix=q.settle(0,2,2);ix.accounts.swap(7,8);q.reject(ix,17);
    let mut ix=q.settle(0,2,2);ix.accounts[5].pubkey=q.f.user_token.pubkey();q.reject(ix,25);
    let original=q.f.svm.get_account(&q.f.state.pubkey()).unwrap();
    // State's collection key is the fourth canonical Key field (tag then bytes).
    let mut changed=original.clone();changed.data[122]^=1;
    q.f.svm.set_account(q.f.state.pubkey(),changed).unwrap();let ix=q.settle(0,2,2);q.reject(ix,257);
    q.f.svm.set_account(q.f.state.pubkey(),original.clone()).unwrap();
    let mut changed=original.clone();changed.data[163..171].copy_from_slice(&36u64.to_le_bytes());
    q.f.svm.set_account(q.f.state.pubkey(),changed).unwrap();let ix=q.settle(0,2,2);q.reject(ix,262);
    q.f.svm.set_account(q.f.state.pubkey(),original).unwrap();
    // Unsolicited tokens remain in custody; they do not become obligations.
    let donate=token::transfer_checked(&spl_token::id(),&q.f.user_token.pubkey(),&q.f.mint.pubkey(),&q.f.vault_token.pubkey(),&q.f.actor.pubkey(),&[],7,6).unwrap();
    q.f.send(&[donate]).unwrap();let ix=q.settle(0,2,2);q.f.send(&[ix]).unwrap();
    assert_eq!(q.f.balances(),(958,7));assert_eq!(q.state()[20],3);
}

#[test]
fn queue_full_u64_funding_rejects_aggregate_overflow(){
    let mut q=QueueFixture::new(4);
    let mut account=q.f.svm.get_account(&q.f.user_token.pubkey()).unwrap();
    let mut token_account=TokenAccount::unpack(&account.data).unwrap();token_account.amount=u64::MAX;
    TokenAccount::pack(token_account,&mut account.data).unwrap();q.f.svm.set_account(q.f.user_token.pubkey(),account).unwrap();
    let ix=q.append(0,u64::MAX);q.f.send(&[ix]).unwrap();let ix=q.append(1,1);q.reject(ix,260);
    let ix=q.seal();q.f.send(&[ix]).unwrap();let ix=q.settle(0,1,1);q.f.send(&[ix]).unwrap();
    assert_eq!(q.destination_balance(0),u64::MAX);assert_eq!(q.f.balances(),(0,0));
}

fn benchmark_call(q:&mut QueueFixture,name:&str,ix:Instruction,error:Option<u32>)->serde_json::Value {
    let accounts:Vec<_>=ix.accounts.iter().filter(|m|m.pubkey!=spl_token::id()).map(|meta|{
        let a=q.f.svm.get_account(&meta.pubkey).unwrap();
        serde_json::json!({"key":meta.pubkey.to_bytes(),"signer":meta.is_signer,"writable":meta.is_writable,"owner":a.owner.to_bytes(),"lamports":a.lamports,"data":a.data,"executable":a.executable})
    }).collect();
    let bytes=ix.data.clone();
    let cu=if let Some(code)=error{q.reject(ix,code)}else if ix.accounts[4].is_signer{
        q.f.send_extra(&[ix],&[&q.collection]).unwrap().compute_units_consumed
    }else{q.f.send(&[ix]).unwrap().compute_units_consumed};
    let after:Vec<_>=q.snapshot().into_iter().map(|a|a.map(|a|serde_json::json!({"data":a.data,"lamports":a.lamports,"owner":a.owner.to_bytes()}))).collect();
    serde_json::json!({"name":name,"cu":cu,"error":error,"instruction":bytes,"accounts":accounts,"after":after})
}

#[test]
#[ignore="run with benchmark:queue after building both implementations"]
fn queue_benchmark_fixed_fixtures(){
    let mut records=vec![];
    for (capacity,length) in [(2,2),(64,33),(256,65)] {
        let mut q=QueueFixture::new(capacity);
        for key in [q.f.state.pubkey(),q.collection.pubkey()] {
            let mut a=q.f.svm.get_account(&key).unwrap();a.data.fill(0);q.f.svm.set_account(key,a).unwrap();
        }
        let ix=q.initialize();records.push(benchmark_call(&mut q,&format!("initialize-c{capacity}"),ix,None));
        let ix=q.append(0,1);records.push(benchmark_call(&mut q,&format!("append-first-c{capacity}"),ix,None));
        for i in 1..length {let ix=q.append(i%2,1);q.f.send(&[ix]).unwrap();}
        let ix=q.seal();records.push(benchmark_call(&mut q,&format!("seal-c{capacity}"),ix,None));
        let page=if length==2{1}else{2};let ix=q.settle(0,page,page);
        records.push(benchmark_call(&mut q,&format!("first-page-{page}-c{capacity}"),ix,None));
        let mut cursor=page as usize;
        while cursor<length-1 {let ix=q.settle(cursor,2,2);q.f.send(&[ix]).unwrap();cursor+=2;}
        let ix=q.settle(cursor,1,1);records.push(benchmark_call(&mut q,&format!("final-page-c{capacity}"),ix,None));
        let ix=q.settle(0,1,1);records.push(benchmark_call(&mut q,&format!("replay-c{capacity}"),ix,Some(258)));
    }
    let mut q=QueueFixture::new(32);
    let ix=q.append(0,0);records.push(benchmark_call(&mut q,"zero-funding",ix,Some(259)));
    let ix=q.append(0,1001);records.push(benchmark_call(&mut q,"insufficient-funding",ix,Some(1)));
    let mut ix=q.append(0,1);ix.accounts[1].pubkey=q.f.attacker.pubkey();records.push(benchmark_call(&mut q,"unauthorized-funding",ix,Some(257)));
    let ix=q.seal();records.push(benchmark_call(&mut q,"empty-seal",ix,Some(259)));
    for i in 0..2 {let ix=q.append(i,1);q.f.send(&[ix]).unwrap();}let ix=q.seal();q.f.send(&[ix]).unwrap();
    let ix=q.settle(0,2,1);records.push(benchmark_call(&mut q,"bad-fuel",ix,Some(261)));
    let freeze=token::freeze_account(&spl_token::id(),&q.destinations[1],&q.f.mint.pubkey(),&q.f.actor.pubkey(),&[]).unwrap();q.f.send(&[freeze]).unwrap();
    let ix=q.settle(0,2,2);records.push(benchmark_call(&mut q,"late-frozen",ix,Some(17)));
    let mut q=QueueFixture::new(1);let ix=q.append(0,1);q.f.send(&[ix]).unwrap();
    let ix=q.append(0,1);records.push(benchmark_call(&mut q,"full-capacity",ix,Some(23)));
    let mut q=QueueFixture::new(4);let mut account=q.f.svm.get_account(&q.f.user_token.pubkey()).unwrap();
    let mut token_account=TokenAccount::unpack(&account.data).unwrap();token_account.amount=u64::MAX;TokenAccount::pack(token_account,&mut account.data).unwrap();q.f.svm.set_account(q.f.user_token.pubkey(),account).unwrap();
    let ix=q.append(0,u64::MAX);q.f.send(&[ix]).unwrap();let ix=q.append(1,1);records.push(benchmark_call(&mut q,"overflow",ix,Some(260)));
    std::fs::write(std::env::var("QUEUE_METRICS").expect("QUEUE_METRICS"),serde_json::to_vec_pretty(&records).unwrap()).unwrap();
}
