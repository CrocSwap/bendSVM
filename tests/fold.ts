import fs from 'node:fs';
import assert from 'node:assert/strict';
import { testPure, type PureCase } from './pure.ts';
import { model } from '../verification/model.ts';
import type { WireValue } from '../sdk/wire.ts';

export const foldRoots=['sum','ordered','conjunction'];
export async function testFold() {
  await testPure('tests/fold.bend',foldRoots,'build/fold',schema=>{
    const ctor=(type:string,tag:number,values:WireValue[]):WireValue=>{
      const t=schema.types.find(t=>t.name===type)!;assert(t.kind==='adt');const v=t.variants[tag];
      return {constructor:v.name,fields:Object.fromEntries(v.fields.map((f,i)=>[f.name,values[i]]))};
    };
    const storage=(type:string,values:WireValue[]):WireValue=>{
      if(values.length===1)return values[0];
      const t=schema.types.find(t=>t.name===type)!;assert(t.kind==='adt');const fields=t.variants[0].fields;
      return ctor(type,0,[storage(fields[0].type,values.slice(0,values.length/2)),storage(fields[1].type,values.slice(values.length/2))]);
    };
    const cases:PureCase[]=[];
    for(const name of foldRoots) {
      const exp=schema.exports.find(e=>e.name===name)!;
      const vt=schema.types.find(t=>t.name===exp.args[1])!;assert(vt.kind==='adt');
      const capacity=name==='conjunction'?2:4;
      const samples:WireValue[][]=name==='conjunction'?[[false,true],[true,true],[true,false]]:
        [[0,1,2,3],[0xffffffff,1,9,2],[1,0xffffffff,0,0]];
      for(const values of samples)for(const initial of name==='conjunction'?[false,true]:[0,7,0xffffffff])
      for(const length of [...Array(capacity+2).keys(),0xffffffff])for(const fuel of [0,1,2,3,4,5,64]) {
        let valid=fuel===length&&length<=capacity;
        let value:WireValue=initial;
        if(valid)for(let i=0;i<length;i++) {
          if(name==='conjunction')value=Boolean(value)&&Boolean(values[i]);
          else if(name==='ordered')value=(Math.imul(value as number,31)+(values[i] as number))>>>0;
          else {const sum=(value as number)+(values[i] as number);if(sum>0xffffffff){valid=false;break;}value=sum;}
        }
        cases.push({name,args:[fuel,ctor(exp.args[1],0,[length,storage(vt.variants[0].fields[1].type,values)]),initial],
          expected:ctor(exp.result,valid?1:0,valid?[value]:[])});
      }
    }
    return cases;
  });
  assert.match(fs.readFileSync('build/fold.h','utf8'),/for \(;;\)/);
  fs.writeFileSync('build/fold.model.json',JSON.stringify(await model('tests/fold.bend',foldRoots))+'\n');
}
if(import.meta.main)await testFold();
