import { TargetDiagnostic } from './diagnostics.ts';
import { mangle } from './backend.ts';
import { wireLayouts, type RuntimeSchema } from './schema.ts';
import { storageHeader } from './storage.ts';
import { emitEffects, effectKind, effectCount } from './effects.ts';

export type CollectionOptions = { select: string; element: string };
export function emitCollectionStorage(schema:RuntimeSchema, root:string, options:CollectionOptions) {
  if(!options || Object.keys(options).sort().join(',')!=='element,select' ||
      typeof options.select!=='string' || typeof options.element!=='string') throw new Error('Invalid collection options: expected select and element');
  const types=new Map(schema.types.map(t=>[t.name,t])), sizes=wireLayouts(schema);
  const fail=(message:string):never=>{throw new TargetDiagnostic('BEND-SBF300', `Collection ABI: ${message}`, 'Match the selection, transition and element layout described in docs/collection-storage.md.');};
  const record=(name:string,names:string[])=>{
    const t=types.get(name);
    if(t?.kind!=='adt'||t.variants.length!==1||t.variants[0].tag!==0||
      t.variants[0].fields.map(f=>f.name).join(',')!==names.join(','))return fail(`expected ${name} record fields ${names.join(',')}`);
    return t.variants[0];
  };
  const u32=(name:string)=>{if(name!=='U32'||types.get(name)?.kind!=='u32')fail(`expected U32, got ${name}`);};
  const fn=schema.exports.find(f=>f.name===root), select=schema.exports.find(f=>f.name===options.select);
  if(!fn||fn.args.length!==5)return fail('transition requires (context, state, instruction, metadata, window)');
  const [ctxName,state,ixName,metadata,window]=fn.args;
  if(!select||select.args.join(',')!==fn.args.slice(0,4).join(','))return fail('selection requires matching (context, state, instruction, metadata)');
  const ctx=record(ctxName,['actor','signed','slot','collection']);
  const keyName=ctx.fields[0].type,key=record(keyName,['a','b','c','d','e','f','g','h']);key.fields.forEach(f=>u32(f.type));
  if(ctx.fields[1].type!=='Bool'||ctx.fields[3].type!==keyName)return fail('invalid context signature or collection key');
  const slot=record(ctx.fields[2].type,['lo','hi']);slot.fields.forEach(f=>u32(f.type));
  const meta=record(metadata,['length','capacity']);meta.fields.forEach(f=>u32(f.type));
  const win=record(window,['start','entries']);u32(win.fields[0].type);
  const vectorName=win.fields[1].type,vector=record(vectorName,['length','storage']);u32(vector.fields[0].type);
  const element=options.element;if(!types.has(element))return fail(`unknown element ${element}`);
  const paths:string[]=[],tags:string[]=[];
  const walk=(name:string,path:string,depth:number)=>{
    if(name===element){paths.push(path);return;}
    if(depth>=3)return fail('window storage exceeds eight elements or does not contain the configured element');
    const pair=record(name,['left','right']);if(pair.fields[0].type!==pair.fields[1].type)return fail('window storage must be homogeneous');
    tags.push(`${path}.tag`);pair.fields.forEach((f,i)=>walk(f.type,`${path}.as.c0.f${i}`,depth+1));
  };
  walk(vector.fields[1].type,'value.as.c0.f1.as.c0.f1',0);
  const capacity=paths.length;
  const choice=types.get(select.result);
  if(choice?.kind!=='adt'||choice.variants.length!==2)return fail('selection must return Invalid/Valid{value: Range}');
  const invalid=choice.variants.find(v=>(v.sourceName??v.name).split('.').at(-1)==='Invalid'),valid=choice.variants.find(v=>(v.sourceName??v.name).split('.').at(-1)==='Valid');
  if(!invalid||invalid.fields.length||!valid||valid.fields.length!==1||valid.fields[0].name!=='value')return fail('invalid selection result');
  const range=record(valid.fields[0].type,['start','count']);range.fields.forEach(f=>u32(f.type));
  const outcome=types.get(fn.result);
  if(outcome?.kind!=='adt'||outcome.variants.length!==2)return fail('expected Accepted/Rejected outcome');
  const accepted=outcome.variants.find(v=>(v.sourceName??v.name).split('.').at(-1)==='Accepted'),rejected=outcome.variants.find(v=>(v.sourceName??v.name).split('.').at(-1)==='Rejected');
  if(!accepted||!rejected||rejected.fields.length!==1||rejected.fields[0].name!=='code')return fail('invalid outcome variants');
  u32(rejected.fields[0].type);
  if(!['state,window,length','state,window,length,effects'].includes(accepted.fields.map(f=>f.name).join(','))||
      accepted.fields[0].type!==state||accepted.fields[1].type!==window)return fail('Accepted requires state, window, length and optional effects');
  u32(accepted.fields[2].type);
  const effects=accepted.fields[3],effectSlots=effects?effectCount(schema,effects.type):0;
  const cpi=effects&&effectKind(schema,effects.type)==='cpi-v1';
  const ci=effects?4:2,n=sizes.get(state)!,ixn=sizes.get(ixName)!,stride=sizes.get(element)!;
  const header=storageHeader(schema,state),collectionHeader=[66,68,67,49,...storageHeader(schema,element).slice(4)];
  const ct=(name:string)=>types.get(name)!.cType;
  const keyOf=(ptr:string)=>`${key.cMaker}(${key.fields.map((_,i)=>`(u32)read_le(${ptr}+${i*4},4)`).join(',')})`;
  const at=(path:string,prefix:string)=>path.replace(/^value/,prefix);
  const c=`/* Generated bounded collection adapter, ABI 3. */
#include "bend_collection_runtime.h"
${effects?emitEffects(schema,effects.type):''}
typedef struct {u64 slot; long long epoch_start_timestamp; u64 epoch; u64 leader_schedule_epoch; long long unix_timestamp;} BendCollectionClock;
extern u64 sol_get_clock_sysvar(void *);
static const u8 state_header[20]={${header}};
static const u8 collection_header[20]={${collectionHeader}};
/* This helper isolates bounded window temporaries from the entrypoint frame. */
__attribute__((noinline)) static u64 bend_collection_run(Account *accounts,unsigned count,const u8 *program,const u8 *ix,unsigned initialize) {
  Account *state=&accounts[0],*actor=&accounts[1];
  if(!equal_key(state->owner,program)||state->executable)return 3;
  if(!state->writable)return 5;
  if(state->size!=${20+n})return 4;
  ${ct(state)} before;
  if(initialize){
    if(!state->signer)return 7;
    for(unsigned i=0;i<${20+n};++i)if(state->data[i])return 4;
    const u8 empty[${n}]={0};if(!${mangle(state)}_decode(empty,${n},&before))return 4;
  }else{
    for(unsigned i=0;i<20;++i)if(state->data[i]!=state_header[i])return 4;
    if(!${mangle(state)}_decode(state->data+20,${n},&before))return 4;
  }
  BendCollection collection;
  u64 error=bend_collection_open(&accounts[${ci}],program,state->key,collection_header,${stride},initialize,&collection);if(error)return error;
  ${ct(ixName)} instruction;if(!${mangle(ixName)}_decode(ix+1,${ixn},&instruction))return 2;
  BendCollectionClock clock;if(sol_get_clock_sysvar(&clock))return 8;
  ${ct(ctxName)} context=${ctx.cMaker}(${keyOf('actor->key')},actor->signer,${slot.cMaker}((u32)clock.slot,(u32)(clock.slot>>32)),${keyOf(`accounts[${ci}].key`)});
  ${ct(metadata)} metadata=${meta.cMaker}(collection.length,collection.capacity);
  ${ct(select.result)} selection=${select.cName}(context,before,instruction,metadata);
  if(selection.tag==${invalid.tag})return 23;
  if(selection.tag!=${valid.tag}||selection.as.c${valid.tag}.f0.tag!=0)return 9;
  BendCollectionWindow selected;
  if(!bend_collection_select(&collection,selection.as.c${valid.tag}.f0.as.c0.f0,selection.as.c${valid.tag}.f0.as.c0.f1,${capacity},&selected))return 23;
  ${ct(window)} value={0};value.as.c0.f0=selected.start;value.as.c0.f1.as.c0.f0=selected.loaded;
  ${paths.map((p,i)=>`if(selected.loaded>${i}&&!${mangle(element)}_decode(bend_collection_record(&collection,&selected,${i}),${stride},&${p}))return 4;`).join('\n  ')}
  ${ct(fn.result)} result=${fn.cName}(context,before,instruction,metadata,value);
  if(result.tag==${rejected.tag}){u32 code=result.as.c${rejected.tag}.f0;return code<=0xfffffeffu?256ULL+code:9;}
  if(result.tag!=${accepted.tag})return 9;
  ${ct(window)} *after=&result.as.c${accepted.tag}.f1;
  if(after->tag||after->as.c0.f1.tag||${tags.length?tags.map(p=>at(p,'(*after)')).join('||'):'0'})return 9;
  if(after->as.c0.f0!=selected.start)return 9;
  u32 written=after->as.c0.f1.as.c0.f0,next=result.as.c${accepted.tag}.f2;
  if(!bend_collection_plan(&collection,&selected,written,next))return 9;
  u8 encoded_state[${n}],encoded_records[${capacity*stride}];
  if(!${mangle(state)}_encode(encoded_state,${n},&result.as.c${accepted.tag}.f0))return 9;
  ${paths.map((p,i)=>`if(written>${i}&&!${mangle(element)}_encode(encoded_records+${i*stride},${stride},&${at(p,'(*after)')}))return 9;`).join('\n  ')}
  ${effects?`u8 bump;error=${cpi?'bend_invoke_custody':'bend_custody'}(accounts,program,&bump);if(error)return error;
  ${cpi?'BendInvoke':'BendTransfer'} transfers[${effectSlots}];
  if(!bend_extract_effects(&result.as.c${accepted.tag}.f3,transfers))return 9;
  for(unsigned i=0;i<${effectSlots};++i){
    error=${cpi?'bend_invoke_validate':'bend_transfer_validate'}(&transfers[i],accounts,count);if(error)return error;
    ${cpi?`if(transfers[i].active)for(unsigned j=0;j<transfers[i].count&&j<8;++j)if(transfers[i].metas[j].writable&&(transfers[i].metas[j].index==0||transfers[i].metas[j].index==${ci}))return 22;`:''}
  }
  for(unsigned i=0;i<${effectSlots};++i)if(${cpi?'bend_invoke_execute':'bend_transfer_execute'}(&transfers[i],accounts,count,bump))return 18;`:'(void)count;'}
  bend_collection_commit(&collection,&selected,written,next,encoded_records,collection_header,state->key);
  __builtin_memcpy(state->data,state_header,20);
  __builtin_memcpy(state->data+20,encoded_state,${n});
  sol_set_return_data(encoded_state,${n});return 0;
}
__attribute__((visibility("default"))) u64 entrypoint(const u8 *input){
  u64 count=read_le(input,8);if(${effects?'count<5||count>12':'count!=3'})return 1;
  Account accounts[${effects?12:3}];const u8 *p=input+8;
  for(unsigned i=0;i<count;++i){p=read_account(p,&accounts[i]);if(!p)return 6;
    for(unsigned j=0;j<i;++j)if(equal_key(accounts[i].key,accounts[j].key))return 6;}
  u64 length=read_le(p,8);const u8 *ix=p+8;if(length!=${ixn+1}||ix[0]>1)return 2;
  return bend_collection_run(accounts,(unsigned)count,ix+length,ix,ix[0]==0);
}
`;
  return {c,interface:{version:3,root,select:options.select,state,instruction:ixName,header,stateBytes:20+n,instructionBytes:ixn+1,
    modes:{initialize:0,transition:1},accounts:effects?['state','actor',cpi?'program':'tokenProgram','custody','collection','remaining...']:['state','actor','collection'],
    effects:effects?effectKind(schema,effects.type):'none',effectSlots,
    collection:{element,header:collectionHeader,headerBytes:56,stride,windowCapacity:capacity,accountIndex:ci,boundStateOffset:24,lengthOffset:20}}};
}
