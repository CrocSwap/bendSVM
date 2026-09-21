import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Backend, checkedBook, mangle } from '../compiler/backend.ts';
import { effectLayout, emitEffects } from '../compiler/effects.ts';
import { buildProgram } from '../scripts/program.ts';
import { run } from '../scripts/build.ts';
import { wireCodec, type WireValue } from '../sdk/wire.ts';

export async function testEffectBuffer() {
  new Backend(await checkedBook('sdk/effect-buffer.bend')).emit(['empty','push']);
  await buildProgram('tests/effect-buffer.bend','process','build/effect-buffer');
  const emitted=new Backend(await checkedBook('tests/effect-buffer.bend')).emit(['process']);
  const schema=emitted.schema,codec=wireCodec(schema);
  const types=new Map(schema.types.map(t=>[t.name,t]));
  const outcome=types.get(schema.exports[0].result)!;assert(outcome.kind==='adt');
  const vector=outcome.variants[0].fields[1].type;
  const layout=effectLayout(schema,vector);assert.equal(layout.paths.length,4);
  assert.equal(JSON.parse(fs.readFileSync('build/effect-buffer.interface.json','utf8')).effectSlots,4);
  const ctor=(name:string,values:WireValue[]):WireValue=>{
    const v=schema.types.flatMap(t=>t.kind==='adt'?t.variants:[]).find(v=>v.name===name)!;
    return {constructor:name,fields:Object.fromEntries(v.fields.map((f,i)=>[f.name,values[i]]))};
  };
  const pack=(type:string,values:WireValue[]):WireValue=>{
    if(values.length===1)return values[0];
    const t=types.get(type)!;assert(t.kind==='adt');const v=t.variants[0];
    return ctor(v.name,[pack(v.fields[0].type,values.slice(0,values.length/2)),pack(v.fields[1].type,values.slice(values.length/2))]);
  };
  const find=(suffix:string)=>schema.types.flatMap(t=>t.kind==='adt'?t.variants:[]).find(v=>v.name.endsWith(suffix))!.name;
  const key=ctor(find('context.Key'),Array(8).fill(0));
  const effects=[1,2,3,4].map(amount=>ctor(find('issuance.Transfer'),[4,5,6,key,ctor(find('effects.ToCustody'),[]),ctor(find('math.U64'),[amount,0]),ctor(find('effects.Actor'),[])]));
  const vt=types.get(vector)!;assert(vt.kind==='adt');
  const cases=[0,1,2,3,4,5,0xffffffff].map(length=>({length,bytes:codec.encode(vector,ctor(vt.variants[0].name,[length,pack(vt.variants[0].fields[1].type,effects)]))}));
  fs.writeFileSync('build/effect-buffer.extract.h',emitEffects(schema,vector));
  fs.writeFileSync('build/effect-buffer-native.c',`#include <stdio.h>
#include "solana_min.h"
#include "token.h"
#include "effect-buffer.wire.h"
#include "effect-buffer.extract.h"
int main(void) {
  unsigned n,b;unsigned char bytes[1024];
  while(scanf("%u",&n)==1) {
    if(n>1024)return 2;
    for(unsigned i=0;i<n;i++){if(scanf("%u",&b)!=1)return 3;bytes[i]=b;}
    ${vt.cType} value;BendTransfer out[4];
    if(!${mangle(vector)}_decode(bytes,n,&value))return 4;
    if(!bend_extract_effects(&value,out)){puts("invalid");continue;}
    for(unsigned i=0;i<4;i++)printf(i?" %u:%llu":"%u:%llu",out[i].active,out[i].amount);
    puts("");
  }
  return 0;
}
`);
  run(process.env.CC??'clang',['-std=c17','-O1','-Wall','-Wextra','-Werror','-Wno-unused-function','-fsanitize=address,undefined','-Iruntime','build/effect-buffer-native.c','-o','build/effect-buffer-native']);
  const result=spawnSync('build/effect-buffer-native',[],{encoding:'utf8',input:cases.map(c=>`${c.bytes.length} ${[...c.bytes].join(' ')}`).join('\n')+'\n'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'),cases.map(c=>c.length>4?'invalid':[0,1,2,3].map(i=>i<c.length?`1:${i+1}`:'0:0').join(' ')));
  for(const mutation of ['length-type','heterogeneous','storage-field']) {
    const altered=structuredClone(schema);const t=altered.types.find(t=>t.name===vector)!;assert(t.kind==='adt');
    if(mutation==='length-type')t.variants[0].fields[0].type='Bool';
    else {
      const store=altered.types.find(x=>x.name===t.variants[0].fields[1].type)!;assert(store.kind==='adt');
      if(mutation==='heterogeneous')store.variants[0].fields[1].type='U32';
      else store.variants[0].fields[0].name='wrong';
    }
    assert.throws(()=>emitEffects(altered,vector));
  }
  console.log('Effect vector extraction: lengths 0–4, inactive slots and oversized lengths passed under sanitizers; malformed schemas rejected');
}
if(import.meta.main)await testEffectBuffer();
