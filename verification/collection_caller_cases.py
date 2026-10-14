"""Actual emitted-C mutations and nontrivial equivalent rewrites."""

def candidate_cases(source):
    def replace(old,new):
        assert source.count(old) == 1, old
        return source.replace(old,new)
    
    mutations = []
    guards = [
        'if(!state->writable)return 5;',
        'if(error)return error;',
        'if(!bend_collection_select(&collection,selection.as.c1.f0.as.c0.f0,selection.as.c1.f0.as.c0.f1,2,&selected))return 23;',
        'if(after->as.c0.f0!=selected.start)return 9;',
        'if(result.tag==1){u32 code=result.as.c1.f0;return code<=0xfffffeffu?256ULL+code:9;}',
        'if(selected.loaded>0&&!bend_U32_decode(bend_collection_record(&collection,&selected,0),4,&value.as.c0.f1.as.c0.f1.as.c0.f0))return 4;',
    ]
    for index, guard in enumerate(guards):
        mutations.append((f'dead nested guard {index}',replace(guard,'if(count==99){'+guard+'}'),'semantic'))
    for name, statement in [
        ('commit','bend_collection_commit(&collection,&selected,written,next,encoded_records,collection_header,state->key);'),
        ('state payload','__builtin_memcpy(state->data+20,encoded_state,5);'),
        ('return data','sol_set_return_data(encoded_state,5);'),
    ]:
        mutations.append(('conditional '+name,replace(statement,'if(next>99){'+statement+'}'),'semantic'))
    loaded = 'value.as.c0.f1.as.c0.f0=selected.loaded;'
    call = 'bend_Outcome_t result=bend_process(context,before,instruction,metadata,value);'
    mutations.append(('length assigned after root',replace(loaded,'').replace(call,call+loaded),'semantic'))
    mutations.append(('signature arguments swapped',replace('const u8 *program,const u8 *ix,unsigned initialize','const u8 *ix,const u8 *program,unsigned initialize'),'grammar'))
    mutations.append(('clock layout reordered',replace('typedef struct {u64 slot; long long epoch_start_timestamp;','typedef struct {long long epoch_start_timestamp; u64 slot;'),'grammar'))
    for name,guard in [
        ('count','if(count!=3)return 1;'),
        ('loader','if(!p)return 6;'),
        ('alias','if(equal_key(accounts[i].key,accounts[j].key))return 6;'),
        ('instruction','if(length!=10||ix[0]>1)return 2;'),
    ]:
        mutations.append(('entry nested dead '+name,replace(guard,'if(input[0]==7){'+guard+'}'),'semantic'))
    mutations.append(('entry wrong program argument',replace('ix+length,ix,ix[0]==0','ix,ix,ix[0]==0'),'grammar'))
    mutations.append(('plan arguments swapped',replace('bend_collection_plan(&collection,&selected,written,next)','bend_collection_plan(&collection,&selected,next,written)'),'grammar'))
    mutations.append(('wrong output state buffer',replace('bend_State_encode(encoded_state,5,&result.as.c0.f0)','bend_State_encode(encoded_records,5,&result.as.c0.f0)'),'grammar'))
    mutations.append(('narrowed next declaration',replace('u32 written=after->as.c0.f1.as.c0.f0,next=result.as.c0.f2','u8 written=after->as.c0.f1.as.c0.f0,next=result.as.c0.f2'),'grammar'))
    mutations.append(('signed overflow guard',replace('if(!state->writable)return 5;','if(!state->writable||2147483647+1<0)return 5;'),'grammar'))
    header = '__builtin_memcpy(state->data,state_header,20);'
    payload = '__builtin_memcpy(state->data+20,encoded_state,5);'
    mutations.append(('state writes reordered',replace(header,'').replace(payload,payload+header),'semantic'))
    for name,old,new in [
        ('octal-size','state->size!=25','state->size!=025'),
        ('truncated-size','state->size!=25','(u32)state->size!=25'),
        ('truncated-count','count!=3','(unsigned)count!=3'),
        ('truncated-length','length!=10','(u32)length!=10'),
        ('left-association','selection.tag==0','selection.tag==1==0'),
        ('post-write-read','sol_set_return_data(encoded_state,5);','sol_set_return_data(encoded_state,5);if(initialize){for(unsigned i=0;i<25;++i)if(state->data[i])return 4;}'),
    ]:
        mutations.append((name,replace(old,new),'semantic'))
    for name,old,new in [
        ('shadow-before','if(initialize){','if(initialize){bend_State_t before;'),
        ('shadow-selected','if(!bend_collection_select(', '{BendCollectionWindow selected;if(!bend_collection_select('),
    ]:
        changed=replace(old,new)
        if name == 'shadow-selected': changed=changed.replace('&selected))return 23;','&selected))return 23;}')
        mutations.append((name,changed,'grammar'))
    for name,statement in [
        ('scope-before','bend_State_t before;'),
        ('scope-collection','BendCollection collection;'),
        ('scope-instruction','bend_Instruction_t instruction;'),
    ]:
        mutations.append((name,replace(statement,'{'+statement+'}'),'grammar'))
    plan_call='if(!bend_collection_plan(&collection,&selected,written,next))return 9;'
    commit_call='bend_collection_commit(&collection,&selected,written,next,encoded_records,collection_header,state->key);'
    return_data='sol_set_return_data(encoded_state,5);'
    mutations.append(('plan repeated after return data',replace(return_data,return_data+plan_call),'grammar'))
    mutations.append(('plan repeated after commit',replace(commit_call,commit_call+plan_call),'grammar'))
    dispatch='bend_collection_run(accounts,(unsigned)count,ix+length,ix,ix[0]==0)'
    mutations.append(('entry double dispatch',replace('return '+dispatch+';','if(!'+dispatch+')return '+dispatch+';return '+dispatch+';'),'grammar'))
    mutations.append(('header read out of bounds',replace(
        'for(unsigned i=0;i<20;++i)if(state->data[i]!=state_header[i])return 4;',
        'for(unsigned i=0;i<25;++i)if(state->data[i]!=state_header[i]&&i<20)return 4;'),'semantic'))
    mutations.append(('alternate zero decoder input outside abstraction',replace(
        'bend_State_decode(empty,5,&before)','bend_State_decode(state->data+20,5,&before)'),'grammar'))
    equivalents = [
        replace('if(initialize){','if(ix[0]==0){'),
        replace('for(unsigned i=0;i<20;++i)if(state->data[i]!=state_header[i])return 4;',
                'for(unsigned i=0;i<25;++i)if(i<20?state->data[i]!=state_header[i]:0)return 4;'),
        replace('if(!state->writable)return 5;','if(state->writable==0)return 5;'),
        replace('if(!equal_key(state->owner,program)||state->executable)return 3;','if(state->executable||!equal_key(state->owner,program))return 3;'),
    ]
    equivalents.extend([
        replace('length!=10','length!=012'),
        replace('selected.loaded>0','selected.loaded==0==0'),
        replace('selection.tag==0','selection.tag!=0!=1'),
    ])
    return mutations, equivalents
