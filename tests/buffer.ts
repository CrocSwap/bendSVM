import fs from 'node:fs';
import assert from 'node:assert/strict';
import { testPure, type PureCase } from './pure.ts';
import { model } from '../verification/model.ts';
import type { WireValue } from '../sdk/wire.ts';

export const bufferRoots=['get_word','set_word','push_word','get_flag','set_flag','push_flag'];
export async function testBuffer() {
  await testPure('tests/buffer.bend',bufferRoots,'build/buffer',schema=>{
    const construct=(type:string,tag:number,values:WireValue[]):WireValue=>{
      const t=schema.types.find(t=>t.name===type)!;
      assert(t.kind==='adt');
      const v=t.variants[tag];
      return {constructor:v.name,fields:Object.fromEntries(v.fields.map((f,i)=>[f.name,values[i]]))};
    };
    const storage=(type:string,values:WireValue[]):WireValue=>{
      if(values.length===1) return values[0];
      const t=schema.types.find(t=>t.name===type)!;assert(t.kind==='adt');
      const half=values.length/2;
      return construct(type,0,[storage(t.variants[0].fields[0].type,values.slice(0,half)),
        storage(t.variants[0].fields[1].type,values.slice(half))]);
    };
    const cases:PureCase[]=[];
    for(const [suffix,capacity,values,value] of [
      ['word',4,[0,1,0x80000000,0xffffffff],17],
      ['flag',2,[false,true],true],
      ['flag',2,[true,false],false],
    ] as const) {
      const get=schema.exports.find(e=>e.name===`get_${suffix}`)!;
      const set=schema.exports.find(e=>e.name===`set_${suffix}`)!;
      const vecType=get.args[0],vt=schema.types.find(t=>t.name===vecType)!;assert(vt.kind==='adt');
      const make=(length:number,xs:WireValue[])=>construct(vecType,0,[length,storage(vt.variants[0].fields[1].type,xs)]);
      for(const length of [...Array(capacity+2).keys(),0xffffffff]) {
        for(const index of [...Array(capacity+1).keys(),0xffffffff]) {
          const valid=length<=capacity&&index<length;
          cases.push({name:get.name,args:[make(length,[...values]),index],
            expected:construct(get.result,valid?1:0,valid?[values[index]]:[])});
          const next=[...values] as WireValue[];if(valid)next[index]=value;
          cases.push({name:set.name,args:[make(length,[...values]),index,value],
            expected:construct(set.result,valid?1:0,valid?[make(length,next)]:[])});
        }
        const valid=length<capacity,next=[...values] as WireValue[];if(valid)next[length]=value;
        cases.push({name:`push_${suffix}`,args:[make(length,[...values]),value],
          expected:construct(set.result,valid?1:0,valid?[make(length+1,next)]:[])});
      }
    }
    return cases;
  });
  fs.writeFileSync('build/buffer.model.json',JSON.stringify(await model('tests/buffer.bend',bufferRoots))+'\n');
}
if(import.meta.main) await testBuffer();
