import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {testPure, type PureCase} from './pure.ts';
import {wireCodec, type WireValue} from '../sdk/wire.ts';
import {run} from '../scripts/build.ts';

export async function testCodecStructures() {
  const ctor = (constructor:string, fields:Record<string,WireValue> = {}):WireValue => ({constructor,fields});
  const cases:PureCase[] = [];
  for(let mask=0;mask<16;mask++) {
    const small = (bit:number) => mask & (1<<bit) ? ctor('Flag',{value:!!(mask&1)}) : ctor('Empty');
    const mixed = (bit:number) => ctor('Mixed',{first:small(bit),fuel:mask&1?64:0,
      word:mask&2?0xffffffff:0x12345678,last:small((bit+1)%4)});
    const value=ctor('Deep',{left:mixed(0),middle:small(2),right:mixed(3),unit:ctor('EmptyUnit')});
    cases.push({name:'identity',args:[value],expected:value});
  }
  const stem='build/codec-structures-runtime';
  await testPure('tests/codec-structures.bend',['identity'],stem,()=>cases);
  const schema=JSON.parse(fs.readFileSync(stem+'.schema.json','utf8'));
  const codec=wireCodec(schema), size=codec.sizes.get('Deep')!;
  const matrix=new Map<string,{input:number[];valid:boolean}>();
  const add=(input:number[])=>{
    let valid=false;
    try { if(input[0]===0){codec.decode('Deep',Uint8Array.from(input.slice(1)));valid=true;} } catch {}
    matrix.set(input.join(','),{input,valid});
  };
  for(const c of cases) {
    const bytes=[...codec.call('identity',c.args)];add(bytes);
    for(let i=1;i<bytes.length;i++)for(const byte of [0,1,2,63,64,65,127,255]) {
      const changed=[...bytes];changed[i]=byte;add(changed);
    }
    add(bytes.slice(0,-1));add([...bytes,0]);add([255,...bytes.slice(1)]);
  }
  add([0,...Array(size).fill(0)]);
  const vectors=[...matrix.values()];
  fs.writeFileSync(stem+'-matrix.json',JSON.stringify(vectors)+'\n');
  fs.writeFileSync(stem+'-matrix.c',`#include <stdio.h>
#include <string.h>
#include "codec-structures-runtime.dispatch.h"
int main(void) {
  unsigned length,byte; unsigned char input[1024],output[${size+2}];
  while(scanf("%u",&length)==1) {
    if(length>1024)return 1;
    for(unsigned i=0;i<length;i++){if(scanf("%u",&byte)!=1||byte>255)return 2;input[i]=byte;}
    memset(output,0xa5,sizeof(output)); unsigned long long written=999;
    int valid=bend_wire_dispatch(input,length,output+1,${size},&written);
    if(output[0]!=0xa5||output[${size+1}]!=0xa5)return 3;
    if(valid && (written!=${size} || length!=${size+1} || memcmp(output+1,input+1,${size})))return 4;
    if(!valid && written!=0)return 5;
    printf("%d\\n",valid);
  }
  return 0;
}
`);
  run(process.env.CC??'clang',['-std=c17','-O1','-Wall','-Wextra','-Werror',
    '-fsanitize=address,undefined','-fno-sanitize-recover=all',stem+'-matrix.c','-o',stem+'-matrix']);
  const result=spawnSync(stem+'-matrix',[],{encoding:'utf8',input:vectors.map(v=>`${v.input.length} ${v.input.join(' ')}`).join('\n')+'\n'});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'),vectors.map(v=>v.valid?'1':'0'));
  console.log(`Structured codec matrix: ${vectors.length} native sanitizer cases, including ${vectors.filter(v=>!v.valid).length} rejections; SBF fixture built`);
}

if(import.meta.main)await testCodecStructures();
