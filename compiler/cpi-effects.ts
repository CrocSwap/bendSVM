import type {RuntimeSchema} from './schema.ts';
export function emitCpiEffects(schema:RuntimeSchema,name:string) {
  const types=new Map(schema.types.map(t=>[t.name,t]));
  const adt=(name:string)=>{const t=types.get(name);if(t?.kind!=='adt')throw new Error('Expected CPI record');return t;};
  const fields=(v:ReturnType<typeof adt>['variants'][number],names:string[])=>{if(v.fields.map(f=>f.name).join(',')!==names.join(','))throw new Error('Invalid CPI fields');};
  const record=(name:string,names:string[])=>{const t=adt(name);if(t.variants.length!==1)throw new Error('Expected CPI record');fields(t.variants[0],names);return t.variants[0];};
  const scalar=(name:string,kind:string)=>{if(types.get(name)?.kind!==kind)throw new Error('Invalid CPI scalar');};
  const key=(name:string)=>record(name,['a','b','c','d','e','f','g','h']).fields.forEach(f=>scalar(f.type,'u32'));
  const pair=record(name,['first','second']);if(pair.fields[0].type!==pair.fields[1].type)throw new Error('CPI effect types differ');
  const effect=adt(pair.fields[0].type);
  if(effect.variants.map(v=>v.name.split('.').at(-1)).join(',')!=='None,Invoke')throw new Error('Expected None/Invoke effects');
  const [none,invoke]=effect.variants;fields(none,[]);fields(invoke,['program','program_key','length','data','count','accounts']);
  for(const i of [0,2,4])scalar(invoke.fields[i].type,'u32');key(invoke.fields[1].type);
  const bytes=record(invoke.fields[3].type,'abcdefghijklmnop'.split(''));bytes.fields.forEach(f=>scalar(f.type,'u32'));
  const metas=record(invoke.fields[5].type,'abcdefgh'.split(''));if(new Set(metas.fields.map(f=>f.type)).size!==1)throw new Error('CPI meta types differ');
  const meta=record(metas.fields[0].type,['index','key','writable','signer']);scalar(meta.fields[0].type,'u32');key(meta.fields[1].type);meta.fields.slice(2).forEach(f=>scalar(f.type,'bool'));
  const copy=(out:string,input:string)=>Array.from({length:8},(_,i)=>`write_le(${out}+${4*i},${input}.as.c0.f${i},4);`).join('\n');
  const f=(i:number)=>`value->as.c${invoke.tag}.f${i}`;
  return `#include <bend_cpi.h>
static inline int bend_extract_effect(const ${effect.cType} *value, BendInvoke *out) {
  *out=(BendInvoke){0}; if(value->tag==${none.tag}) return 1; if(value->tag!=${invoke.tag}) return 0;
  out->active=1;out->program=${f(0)};out->length=${f(2)};out->count=${f(4)};
  ${copy('out->program_key',f(1))}
  ${Array.from({length:16},(_,i)=>`write_le(out->data+${4*i},${f(3)}.as.c0.f${i},4);`).join('\n')}
  ${Array.from({length:8},(_,i)=>{const m=`${f(5)}.as.c0.f${i}.as.c0`;return `out->metas[${i}].index=${m}.f0;out->metas[${i}].writable=${m}.f2;out->metas[${i}].signer=${m}.f3;${copy(`out->metas[${i}].key`,`${m}.f1`)}`;}).join('\n')}
  return 1;
}
static inline int bend_extract_effects(const ${adt(name).cType} *value,BendInvoke *out) {
  return value->tag==0 && bend_extract_effect(&value->as.c0.f0,&out[0]) && bend_extract_effect(&value->as.c0.f1,&out[1]);
}
`;
}
