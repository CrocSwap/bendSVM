import { mangle } from './backend.ts';
import { wireLayouts, type RuntimeSchema } from './schema.ts';
import { emitEffects, effectKind, effectCount } from './effects.ts';
import { storageHeader, type emitSingleStorage } from './storage.ts';

// The single-account descriptor validates the common context/result/effect ABI.
export function emitMultiStorage(schema: RuntimeSchema, root: string, fields: string[], baseline: ReturnType<typeof emitSingleStorage>['interface']) {
  const types = new Map(schema.types.map(t=>[t.name,t]));
  const sizes = wireLayouts(schema);
  const fn = schema.exports.find(f=>f.name===root)!;
  const state = types.get(baseline.state)!;
  if (!Array.isArray(fields) || fields.length < 2 || fields.length > 4 ||
      state.kind !== 'adt' || state.variants.length !== 1 ||
      JSON.stringify(state.variants[0].fields.map(f=>f.name)) !== JSON.stringify(fields)) {
    throw new Error('Multiple state accounts require all fields of a 2–4 field record in declaration order');
  }
  const result = types.get(fn.result)!;
  if (result.kind !== 'adt') throw new Error('Invalid result');
  const accepted = result.variants.find(v=>v.name.split('.').at(-1)==='Accepted')!;
  const rejected = result.variants.find(v=>v.name.split('.').at(-1)==='Rejected')!;
  const effects = accepted.fields[1];
  const cpi=effects && effectKind(schema,effects.type)==='cpi-v1';
  const effectSlots=effects?effectCount(schema,effects.type):0;
  const getRecord=(name:string)=>{const t=types.get(name)!;if(t.kind!=='adt')throw new Error('Invalid record');return t.variants[0];};
  const ctx=getRecord(fn.args[0]),key=getRecord(ctx.fields[0].type),slot=getRecord(ctx.fields[2].type);
  const accounts=state.variants[0].fields.map((field,i)=>({field:field.name,type:field.type,index:i===0?0:i+(effects?3:1),header:storageHeader(schema,field.type),stateBytes:20+sizes.get(field.type)!}));
  const minimum=accounts.length+(effects?3:1),maximum=effects?12:minimum;
  const n=sizes.get(baseline.state)!,ixn=sizes.get(baseline.instruction)!;
  const c=`/* Generated multi-account state adapter, ABI version 2. */
#include "solana_min.h"
${effects?emitEffects(schema,effects.type):''}
typedef struct { u64 slot; long long epoch_start_timestamp; u64 epoch; u64 leader_schedule_epoch; long long unix_timestamp; } BendClock;
_Static_assert(sizeof(BendClock) == 40, "Clock ABI");
extern u64 sol_get_clock_sysvar(void *);
__attribute__((visibility("default")))
u64 entrypoint(const u8 *input) {
  u64 count = read_le(input,8);
  if (count < ${minimum} || count > ${maximum}) return 1;
  Account accounts[${maximum}];
  const u8 *p=input+8;
  for (unsigned i=0;i<count;++i) {
    p=read_account(p,&accounts[i]); if (!p) return 6;
    for (unsigned j=0;j<i;++j) if (equal_key(accounts[i].key,accounts[j].key)) return 6;
  }
  Account actor=accounts[1];
  u64 length=read_le(p,8); const u8 *ix=p+8; const u8 *program=ix+length;
  if (length != ${ixn+1} || ix[0]>1) return 2;
  ${effects?`u8 bump; u64 setup=${cpi?'bend_invoke_custody':'bend_custody'}(accounts,program,&bump); if(setup) return setup;`:''}
${accounts.map((a,i)=>`  Account state${i}=accounts[${a.index}];
  if (!equal_key(state${i}.owner,program) || state${i}.executable) return 3;
  if (!state${i}.writable) return 5;
  if (state${i}.size != ${a.stateBytes}) return 4;
  const u8 header${i}[20]={${a.header.join(',')}};
  ${types.get(a.type)!.cType} before${i};
  if (ix[0]==0) {
    if (!state${i}.signer) return 7;
    for(unsigned j=0;j<${a.stateBytes};++j) if(state${i}.data[j]) return 4;
    const u8 empty${i}[${a.stateBytes-20}]={0};
    if(!${mangle(a.type)}_decode(empty${i},${a.stateBytes-20},&before${i})) return 4;
  } else {
    for(unsigned j=0;j<20;++j) if(state${i}.data[j]!=header${i}[j]) return 4;
    if(!${mangle(a.type)}_decode(state${i}.data+20,${a.stateBytes-20},&before${i})) return 4;
  }`).join('\n')}
  ${types.get(baseline.instruction)!.cType} instruction;
  if(!${mangle(baseline.instruction)}_decode(ix+1,${ixn},&instruction)) return 2;
  BendClock clock; if(sol_get_clock_sysvar(&clock)) return 8;
  ${types.get(fn.args[0])!.cType} context=${ctx.cMaker}(${key.cMaker}(${key.fields.map((_,i)=>`(u32)read_le(actor.key+${i*4},4)`).join(',')}),actor.signer,${slot.cMaker}((u32)clock.slot,(u32)(clock.slot>>32)));
  ${state.cType} before=${state.variants[0].cMaker}(${accounts.map((_,i)=>`before${i}`).join(',')});
  ${result.cType} outcome=${fn.cName}(context,before,instruction);
  if(outcome.tag==${rejected.tag}) { u32 code=outcome.as.c${rejected.tag}.f0; return code<=0xfffffeffu?256ULL+code:9; }
  if(outcome.tag!=${accepted.tag}) return 9;
  const ${state.cType} *after=&outcome.as.c${accepted.tag}.f0;
  u8 reply[${n}]; if(!${mangle(baseline.state)}_encode(reply,${n},after)) return 9;
${accounts.map((a,i)=>`  u8 encoded${i}[${a.stateBytes-20}];
  if(!${mangle(a.type)}_encode(encoded${i},${a.stateBytes-20},&after->as.c${state.variants[0].tag}.f${i})) return 9;`).join('\n')}
  ${effects?`${cpi?'BendInvoke':'BendTransfer'} transfers[${effectSlots}];
  if(!bend_extract_effects(&outcome.as.c${accepted.tag}.f1,transfers)) return 9;
  for(unsigned i=0;i<${effectSlots};++i) { u64 error=${cpi?'bend_invoke_validate':'bend_transfer_validate'}(&transfers[i],accounts,(unsigned)count); if(error) return error; ${cpi?`if(transfers[i].active) for(unsigned j=0;j<transfers[i].count;++j) if(transfers[i].metas[j].writable && (${accounts.map(a=>`transfers[i].metas[j].index==${a.index}`).join(' || ')})) return 22;`:''} }
  for(unsigned i=0;i<${effectSlots};++i) if(${cpi?'bend_invoke_execute':'bend_transfer_execute'}(&transfers[i],accounts,(unsigned)count,bump)) return 18;`:''}
${accounts.map((a,i)=>`  for(unsigned j=0;j<20;++j) state${i}.data[j]=header${i}[j];
  for(unsigned j=0;j<${a.stateBytes-20};++j) state${i}.data[20+j]=encoded${i}[j];`).join('\n')}
  sol_set_return_data(reply,${n}); return 0;
}
`;
  return {c,interface:{version:2 as const,root,state:baseline.state,instruction:baseline.instruction,
    stateAccounts:accounts,instructionBytes:ixn+1,modes:{initialize:0,transition:1},
    accounts:effects?[fields[0],'actor',cpi?'program':'tokenProgram','custody',...fields.slice(1),'remaining...']:[fields[0],'actor',...fields.slice(1)],
    effects:effects?effectKind(schema,effects.type):'none',minimumAccounts:minimum,maximumAccounts:maximum,
    ...(effectSlots>2?{effectSlots}:{})}};
}
