import type { RuntimeSchema } from './schema.ts';
import { emitCpiEffects } from './cpi-effects.ts';

// Describe fixed records and runtime-length vectors using their checked schema.
// Pair storage determines capacity; no application or generic-instance names
// participate in this lowering.
export function effectLayout(schema: RuntimeSchema, name: string) {
  const types=new Map(schema.types.map(t=>[t.name,t]));
  const record=types.get(name);
  if(record?.kind!=='adt'||record.variants.length!==1)throw new Error('Expected Effects record');
  const fields=record.variants[0].fields;
  if(['first,second','first,second,third'].includes(fields.map(f=>f.name).join(','))) {
    if(fields.some(f=>f.type!==fields[0].type))throw new Error('Effect types differ');
    return {type:fields[0].type,paths:fields.map((_,i)=>`value->as.c0.f${i}`),tags:['value->tag'],length:undefined as string|undefined};
  }
  if(fields.map(f=>f.name).join(',')!=='length,storage'||fields[0].type!=='U32')
    throw new Error('Expected fixed effect fields or bounded effect vector');
  const paths:string[]=[],tags=['value->tag'];let effectType:string|undefined;
  const walk=(name:string,path:string,depth:number)=>{
    if(depth>3)throw new Error('Effect vector exceeds eight slots');
    const type=types.get(name);
    if(type?.kind!=='adt')throw new Error('Expected effect storage type');
    if(type.variants.length>1) {
      if(effectType!==undefined&&effectType!==name)throw new Error('Effect types differ');
      effectType=name;paths.push(path);return;
    }
    const fs=type.variants[0]?.fields;
    if(!fs||fs.map(f=>f.name).join(',')!=='left,right'||fs[0].type!==fs[1].type)
      throw new Error('Expected homogeneous Pair effect storage');
    tags.push(`${path}.tag`);
    fs.forEach((f,i)=>walk(f.type,`${path}.as.c0.f${i}`,depth+1));
  };
  walk(fields[1].type,'value->as.c0.f1',0);
  if(!effectType||paths.length<2||paths.length>8)throw new Error('Effect vector capacity must be two, four or eight');
  return {type:effectType,paths,tags,length:'value->as.c0.f0'};
}

export function effectCount(schema: RuntimeSchema, name: string): number {
  return effectLayout(schema,name).paths.length;
}

export function effectKind(schema: RuntimeSchema, name: string): 'token-v1' | 'token-v2' | 'cpi-v1' {
  const layout=effectLayout(schema,name);
  const effect=schema.types.find(t=>t.name===layout.type);
  if (effect?.kind === 'adt' && effect.variants.some(v => v.name.split('.').at(-1) === 'Invoke')) return 'cpi-v1';
  return effect?.kind === 'adt' && effect.variants.some(v => v.name.split('.').at(-1) === 'Mint') ? 'token-v2' : 'token-v1';
}

// Structural lowering of the SDK's bounded token effects. Ordinary Bend code
// constructs these values; only the external effect execution belongs here.
export function emitEffects(schema: RuntimeSchema, name: string) {
  const layout=effectLayout(schema,name);
  if (effectKind(schema,name)==='cpi-v1') {
    if(layout.length)throw new Error('CPI vectors are not supported');
    return emitCpiEffects(schema,name);
  }
  const types = new Map(schema.types.map(t => [t.name,t]));
  const adt = (name: string) => {
    const t = types.get(name);
    if (t?.kind !== 'adt') throw new Error(`Expected effects data type: ${name}`);
    return t;
  };
  const fields = (v: ReturnType<typeof adt>['variants'][number], names: string[]) => {
    if (v.fields.map(f => f.name).join(',') !== names.join(',')) throw new Error(`Invalid effect fields: ${v.name}`);
  };
  const scalar = (type: string) => { if (types.get(type)?.kind !== 'u32') throw new Error('Expected U32 effect field'); };
  const key = (type: string) => {
    const t = adt(type);
    if (t.variants.length !== 1) throw new Error('Expected key record');
    fields(t.variants[0],['a','b','c','d','e','f','g','h']);
    t.variants[0].fields.forEach(f => scalar(f.type));
  };
  const effects = adt(name);
  if (effects.variants.length !== 1) throw new Error('Expected Effects record');
  const count = effectCount(schema, name);
  const effect = adt(layout.type);
  const issuance = effectKind(schema, name) === 'token-v2';
  if (effect.variants.length !== (issuance ? 6 : 3)) throw new Error('Invalid token effect variants');
  const none = effect.variants.find(v => v.name.split('.').at(-1) === 'None');
  const transfer = effect.variants.find(v => v.name.split('.').at(-1) === 'Transfer');
  const check = effect.variants.find(v => v.name.split('.').at(-1) === 'CheckMint');
  if (!none || !transfer || !check) throw new Error('Expected None/Transfer/CheckMint');
  fields(check,['mint','mint_key']); scalar(check.fields[0].type); key(check.fields[1].type);
  fields(none,[]); fields(transfer,['source','destination','mint','mint_key','recipient','amount','authority']);
  transfer.fields.slice(0,3).forEach(f => scalar(f.type)); key(transfer.fields[3].type);
  const recipient = adt(transfer.fields[4].type), amount = adt(transfer.fields[5].type), authority = adt(transfer.fields[6].type);
  if (amount.variants.length !== 1) throw new Error('Expected U64 amount');
  fields(amount.variants[0],['lo','hi']); amount.variants[0].fields.forEach(f => scalar(f.type));
  const checkVariants = (t: typeof recipient, names: string[]) => {
    if (t.variants.map(v => v.name.split('.').at(-1)).join(',') !== names.join(',')) throw new Error(`Invalid effect enum: ${t.name}`);
  };
  checkVariants(recipient,['ToActor','ToCustody','ToOwner']);
  fields(recipient.variants[0],[]); fields(recipient.variants[1],[]); fields(recipient.variants[2],['key']);
  key(recipient.variants[2].fields[0].type);
  checkVariants(authority,['Actor','Custody']); authority.variants.forEach(v => fields(v,[]));
  const mint = effect.variants.find(v => v.name.split('.').at(-1) === 'Mint');
  const burn = effect.variants.find(v => v.name.split('.').at(-1) === 'Burn');
  const bound = effect.variants.find(v => v.name.split('.').at(-1) === 'BoundTransfer');
  if (issuance) {
    if (!mint || !burn || !bound) throw new Error('Expected Mint/Burn/BoundTransfer effects');
    fields(mint, ['destination','mint','mint_key','recipient','amount','initialize']);
    fields(burn, ['source','mint','mint_key','amount']);
    for (const v of [mint, burn]) {
      scalar(v.fields[0].type); scalar(v.fields[1].type); key(v.fields[2].type);
    }
    if (mint.fields[3].type !== transfer.fields[4].type || mint.fields[4].type !== transfer.fields[5].type ||
        burn.fields[3].type !== transfer.fields[5].type || types.get(mint.fields[5].type)?.kind !== 'bool')
      throw new Error('Invalid issuance effect types');
    fields(bound, ['transfer','source','destination','fresh_destination']);
    const details = adt(bound.fields[0].type);
    if (details.variants.length !== 1 || JSON.stringify(details.variants[0].fields) !== JSON.stringify(transfer.fields))
      throw new Error('Invalid bound transfer details');
    if (bound.fields[1].type !== bound.fields[2].type || types.get(bound.fields[3].type)?.kind !== 'bool')
      throw new Error('Invalid bound transfer types');
    const binding = adt(bound.fields[1].type);
    checkVariants(binding, ['Any','Exact']); fields(binding.variants[0], []); fields(binding.variants[1], ['key']);
    key(binding.variants[1].fields[0].type);
  }
  const f = (i: number) => `value->as.c${transfer.tag}.f${i}`;
  const copyKey = (target: string, source: string) => Array.from({length:8},(_,i) =>
    `write_le(${target}+${4*i}, ${source}.as.c0.f${i}, 4);`).join('\n');
  const extractAmount = (source: string) => `if (${source}.tag != 0) return 0;
    out->amount = (u64)${source}.as.c0.f0 | ((u64)${source}.as.c0.f1 << 32);`;
  const extractRecipient = (source: string) => `out->recipient = ${source}.tag;
    if (out->recipient > 2) return 0;
    if (out->recipient == 2) { ${copyKey('out->recipient_key',`${source}.as.c2.f0`)} }`;
  const extractBound = issuance ? `if (value->tag == ${bound!.tag}) {
    if (value->as.c${bound!.tag}.f0.tag != 0) return 0;
    out->active = 1;
    out->source = value->as.c${bound!.tag}.f0.as.c0.f0;
    out->destination = value->as.c${bound!.tag}.f0.as.c0.f1;
    out->mint = value->as.c${bound!.tag}.f0.as.c0.f2;
    ${copyKey('out->mint_key',`value->as.c${bound!.tag}.f0.as.c0.f3`)}
    ${extractRecipient(`value->as.c${bound!.tag}.f0.as.c0.f4`)}
    ${extractAmount(`value->as.c${bound!.tag}.f0.as.c0.f5`)}
    out->authority = value->as.c${bound!.tag}.f0.as.c0.f6.tag;
    out->source_bound = value->as.c${bound!.tag}.f1.tag;
    out->destination_bound = value->as.c${bound!.tag}.f2.tag;
    if (out->source_bound == 1) { ${copyKey('out->source_key',`value->as.c${bound!.tag}.f1.as.c1.f0`)} }
    if (out->destination_bound == 1) { ${copyKey('out->destination_key',`value->as.c${bound!.tag}.f2.as.c1.f0`)} }
    out->fresh_destination = value->as.c${bound!.tag}.f3;
    return out->authority <= 1 && out->source_bound <= 1 && out->destination_bound <= 1 && out->fresh_destination <= 1;
  }` : '';
  return `#include "token.h"
static inline int bend_extract_effect(const ${effect.cType} *value, BendTransfer *out) {
  *out = (BendTransfer){0};
  if (value->tag == ${none.tag}) return 1;
  ${extractBound}
  if (value->tag == ${check.tag}) {
    out->active = 2; out->mint = value->as.c${check.tag}.f0;
    ${copyKey('out->mint_key',`value->as.c${check.tag}.f1`)}
    return 1;
  }
  ${issuance ? `if (value->tag == ${mint!.tag}) {
    out->active = 3; out->authority = 1;
    out->destination = value->as.c${mint!.tag}.f0; out->mint = value->as.c${mint!.tag}.f1;
    ${copyKey('out->mint_key',`value->as.c${mint!.tag}.f2`)}
    ${extractRecipient(`value->as.c${mint!.tag}.f3`)}
    ${extractAmount(`value->as.c${mint!.tag}.f4`)}
    out->initialize = value->as.c${mint!.tag}.f5;
    return out->initialize <= 1;
  }
  if (value->tag == ${burn!.tag}) {
    out->active = 4; out->source = value->as.c${burn!.tag}.f0; out->mint = value->as.c${burn!.tag}.f1;
    ${copyKey('out->mint_key',`value->as.c${burn!.tag}.f2`)}
    ${extractAmount(`value->as.c${burn!.tag}.f3`)}
    return 1;
  }` : ''}
  if (value->tag != ${transfer.tag}) return 0;
  out->active = 1;
  out->source = ${f(0)}; out->destination = ${f(1)}; out->mint = ${f(2)};
  ${copyKey('out->mint_key',f(3))}
  out->recipient = ${f(4)}.tag;
  if (out->recipient == 2) { ${copyKey('out->recipient_key',`${f(4)}.as.c2.f0`)} }
  if (${f(5)}.tag != 0) return 0;
  out->amount = (u64)${f(5)}.as.c0.f0 | ((u64)${f(5)}.as.c0.f1 << 32);
  out->authority = ${f(6)}.tag;
  return out->authority <= 1 && out->recipient <= 2;
}
static inline int bend_extract_effects(const ${effects.cType} *value, BendTransfer *out) {
  ${layout.length ? `if (${layout.tags.map(t=>`${t} != 0`).join(' || ')} || ${layout.length} > ${count}u) return 0;
  ${layout.paths.map((path,i)=>`if (${i}u < ${layout.length}) {
    if (!bend_extract_effect(&${path}, &out[${i}])) return 0;
  } else { out[${i}] = (BendTransfer){0}; }`).join('\n  ')}
  return 1;` : `return value->tag == 0 && ${layout.paths.map((path,i)=>`bend_extract_effect(&${path},&out[${i}])`).join(' &&\n    ')};` }
}
`;
}
