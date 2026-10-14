use super::*;

struct CollectionFixture {
    svm: LiteSVM,
    program: Pubkey,
    payer: Keypair,
    state: Keypair,
    collection: Keypair,
    record: bool,
}
impl CollectionFixture {
    fn new(capacity: usize) -> Self {
        Self::with_record(capacity,false)
    }
    fn with_record(capacity: usize, record: bool) -> Self {
        let mut svm = crate::test_svm().with_transaction_history(0);
        let program = Pubkey::new_unique();
        svm.add_program_from_file(program, if record {"build/collection-record.so"} else {"build/collection-store.so"}).unwrap();
        let payer = Keypair::new();
        let state = Keypair::new();
        let collection = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
        for (key, size) in [(state.pubkey(),25),(collection.pubkey(),56+capacity*if record {6}else{4})] {
            svm.set_account(key,Account {lamports:10_000_000,data:vec![0;size],owner:program,executable:false,rent_epoch:0}).unwrap();
        }
        Self{svm,program,payer,state,collection,record}
    }
    fn instruction(&self, initialize: bool, replace: Option<u32>, value: u32) -> Instruction {
        let mut data=vec![if initialize {0}else{1},if replace.is_some(){1}else{0}];
        if let Some(index)=replace {data.extend_from_slice(&index.to_le_bytes());}
        if self.record {data.extend_from_slice(&[0,(value&1) as u8]);}
        data.extend_from_slice(&value.to_le_bytes());data.resize(if self.record {12}else{10},0);
        Instruction{program_id:self.program,accounts:vec![
            AccountMeta::new(self.state.pubkey(),initialize),
            AccountMeta::new_readonly(self.payer.pubkey(),true),
            AccountMeta::new(self.collection.pubkey(),initialize)],data}
    }
    fn send(&mut self, ix:Instruction, _initialize:bool)->TransactionResult {
        let mut signers=vec![&self.payer];
        if ix.accounts.iter().any(|m|m.is_signer&&m.pubkey==self.state.pubkey()){signers.push(&self.state);}
        if ix.accounts.iter().any(|m|m.is_signer&&m.pubkey==self.collection.pubkey()){signers.push(&self.collection);}
        let tx=Transaction::new(&signers,Message::new(&[ix],Some(&self.payer.pubkey())),self.svm.latest_blockhash());
        self.svm.send_transaction(tx)
    }
    fn bytes(&self)->Vec<u8>{self.svm.get_account(&self.collection.pubkey()).unwrap().data}
    fn rejected(&mut self,ix:Instruction,code:u32) {
        let state=self.svm.get_account(&self.state.pubkey()).unwrap();let collection=self.bytes();
        let e=self.send(ix,false).unwrap_err();
        assert_eq!(e.err,TransactionError::InstructionError(0,InstructionError::Custom(code)));
        assert_eq!(self.bytes(),collection);assert_eq!(self.svm.get_account(&self.state.pubkey()).unwrap(),state);
    }
}

#[test]
fn collection_storage_persists_large_accounts_and_rejects_invalid_windows() {
    let mut f=CollectionFixture::new(4096);
    let ix=f.instruction(true,None,17);f.send(ix,true).unwrap();
    for value in 1..300 {let ix=f.instruction(false,None,value);f.send(ix,false).unwrap();}
    let before=f.bytes();assert_eq!(before.len(),16440);
    assert_eq!(u32::from_le_bytes(before[20..24].try_into().unwrap()),300);
    assert_eq!(&before[24..56],f.state.pubkey().as_ref());
    for index in [0,1,127,299] {
        let prior=f.bytes();let ix=f.instruction(false,Some(index),0xffffffff);f.send(ix,false).unwrap();
        let after=f.bytes();let offset=56+index as usize*4;
        assert_eq!(&after[..offset],&prior[..offset]);assert_eq!(&after[offset+4..],&prior[offset+4..]);
        assert_eq!(&after[offset..offset+4],&[255;4]);
    }
    for index in [300,4095,0xffffffff] {let ix=f.instruction(false,Some(index),1);f.rejected(ix,23);}
    // Even checked source can propose an invalid adapter outcome. It must not
    // move the window, remove loaded records, or grow length without writes.
    for mode in 0..3 {
        let mut ix=f.instruction(false,None,mode);ix.data[1]=2;f.rejected(ix,9);
    }
    let mut ix=f.instruction(false,Some(0),1);ix.data[0]=2;f.rejected(ix,2);
    let mut ix=f.instruction(false,Some(0),1);ix.accounts[2].is_writable=false;f.rejected(ix,5);
    let mut ix=f.instruction(false,Some(0),1);ix.accounts[2].pubkey=f.state.pubkey();f.rejected(ix,6);
}

#[test]
fn collection_storage_checks_binding_schema_length_owner_and_full_capacity() {
    let mut f=CollectionFixture::new(1);let ix=f.instruction(true,None,73);f.send(ix,true).unwrap();
    let ix=f.instruction(false,None,74);f.rejected(ix,23);
    let original=f.svm.get_account(&f.collection.pubkey()).unwrap();
    for offset in [0,4,24,55] {
        let mut changed=original.clone();changed.data[offset]^=1;
        f.svm.set_account(f.collection.pubkey(),changed).unwrap();
        let ix=f.instruction(false,Some(0),1);f.rejected(ix,4);
        f.svm.set_account(f.collection.pubkey(),original.clone()).unwrap();
    }
    let mut changed=original.clone();changed.data[20..24].copy_from_slice(&2u32.to_le_bytes());
    f.svm.set_account(f.collection.pubkey(),changed).unwrap();let ix=f.instruction(false,Some(0),1);f.rejected(ix,4);
    let mut changed=original.clone();changed.owner=Pubkey::new_unique();
    f.svm.set_account(f.collection.pubkey(),changed).unwrap();let ix=f.instruction(false,Some(0),1);f.rejected(ix,3);
    let mut changed=original.clone();changed.data.push(0);
    f.svm.set_account(f.collection.pubkey(),changed).unwrap();let ix=f.instruction(false,Some(0),1);f.rejected(ix,4);
}

#[test]
fn collection_record_storage_checks_canonical_elements_and_ignores_unselected_bytes() {
    let mut f=CollectionFixture::with_record(2048,true);
    let ix=f.instruction(true,None,73);f.send(ix,true).unwrap();
    for value in 1..200 {let ix=f.instruction(false,None,value);f.send(ix,false).unwrap();}
    let before=f.bytes();assert_eq!(before.len(),12344);
    assert_eq!(u32::from_le_bytes(before[20..24].try_into().unwrap()),200);
    for index in [0,100,199] {
        let before=f.bytes();let ix=f.instruction(false,Some(index),42);f.send(ix,false).unwrap();
        let after=f.bytes();let offset=56+index as usize*6;
        assert_eq!(&after[..offset],&before[..offset]);assert_eq!(&after[offset+6..],&before[offset+6..]);
        assert_eq!(&after[offset..offset+6],&[0,0,42,0,0,0]);
    }
    let original=f.svm.get_account(&f.collection.pubkey()).unwrap();
    for (offset,value) in [(56,1),(57,2)] {
        let mut changed=original.clone();changed.data[offset]=value;
        f.svm.set_account(f.collection.pubkey(),changed).unwrap();
        let ix=f.instruction(false,Some(0),3);f.rejected(ix,4);
        // Decoding stays bounded: an unrelated active record remains usable.
        let ix=f.instruction(false,Some(100),5);f.send(ix,false).unwrap();
        assert_eq!(f.bytes()[offset],value);
        f.svm.set_account(f.collection.pubkey(),original.clone()).unwrap();
    }
    let mut changed=original.clone();changed.data[56+200*6]=255;
    f.svm.set_account(f.collection.pubkey(),changed).unwrap();
    // Appending overwrites inactive storage instead of interpreting it as a value.
    let ix=f.instruction(false,None,99);f.send(ix,false).unwrap();
    assert_eq!(&f.bytes()[56+200*6..56+201*6],&[0,1,99,0,0,0]);
    let mut ix=f.instruction(false,Some(0),1);ix.data[7]=2;f.rejected(ix,2);
}

#[test]
fn collection_initialization_requires_both_signers_and_clean_allocations(){
    let mut f=CollectionFixture::new(8);
    for account in [0,2] {
        let before=f.svm.get_account(&f.state.pubkey()).unwrap();let bytes=f.bytes();
        let mut ix=f.instruction(true,None,1);ix.accounts[account].is_signer=false;
        let error=f.send(ix,true).unwrap_err();assert_eq!(error.err,TransactionError::InstructionError(0,InstructionError::Custom(7)));
        assert_eq!(f.bytes(),bytes);assert_eq!(f.svm.get_account(&f.state.pubkey()).unwrap(),before);
    }
    let original=f.svm.get_account(&f.collection.pubkey()).unwrap();
    let mut dirty=original.clone();*dirty.data.last_mut().unwrap()=1;f.svm.set_account(f.collection.pubkey(),dirty).unwrap();
    let before=f.svm.get_account(&f.state.pubkey()).unwrap();let bytes=f.bytes();
    let ix=f.instruction(true,None,1);let error=f.send(ix,true).unwrap_err();
    assert_eq!(error.err,TransactionError::InstructionError(0,InstructionError::Custom(4)));
    assert_eq!(f.bytes(),bytes);assert_eq!(f.svm.get_account(&f.state.pubkey()).unwrap(),before);
    f.svm.set_account(f.collection.pubkey(),original).unwrap();
    let ix=f.instruction(true,None,17);f.send(ix,true).unwrap();
    let bytes=f.bytes();let before=f.svm.get_account(&f.state.pubkey()).unwrap();
    let ix=f.instruction(true,None,1);let error=f.send(ix,true).unwrap_err();
    assert_eq!(error.err,TransactionError::InstructionError(0,InstructionError::Custom(4)));
    assert_eq!(f.bytes(),bytes);assert_eq!(f.svm.get_account(&f.state.pubkey()).unwrap(),before);
}
