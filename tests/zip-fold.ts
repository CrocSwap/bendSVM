import assert from 'node:assert/strict';
import type {WireValue} from '../sdk/wire.ts';
import {testPure} from './pure.ts';

export async function testZipFold() {
  await testPure('tests/zip-fold.bend',['order'],'build/zip-fold',schema=>{
    const types=new Map(schema.types.map(t=>[t.name,t]));
    const rowType=schema.exports.find(e=>e.name==='order')!.args[0];
    function row(values:number[]):WireValue {
      assert.equal(values.length,32);
      let next=0;
      function build(name:string):WireValue {
        if(name==='U32')return values[next++];
        const type=types.get(name)!;
        assert.equal(type.kind,'adt');
        const variant=type.variants[0];
        return {constructor:variant.name,fields:Object.fromEntries(
          variant.fields.map(field=>[field.name,build(field.type)]))};
      }
      const result=build(rowType);
      assert.equal(next,32);
      return result;
    }
    const zero=Array(32).fill(0);
    const ascending=Array.from({length:32},(_,i)=>i+1);
    const descending=Array.from({length:32},(_,i)=>32-i);
    const cases=[
      {q:zero,w:zero,initial:0},
      {q:ascending,w:descending,initial:17},
      {q:descending,w:ascending,initial:0xffffffff},
      {q:ascending,w:zero,initial:12345},
      {q:zero,w:descending,initial:23456},
      ...[0,15,16,31].map(at=>({q:zero.map((_,i)=>i===at?0xffffffff:0),
        w:zero.map((_,i)=>i===at?0x80000000:0),initial:at})),
      {q:ascending.map(x=>(x*7919)>>>0),w:descending.map(x=>(x*65537)>>>0),initial:987654321},
    ];
    return cases.map(({q,w,initial})=>{
      let expected=initial>>>0;
      for(let i=0;i<32;i++) expected=(Math.imul(expected,131)+Math.imul(q[i],7)+w[i])>>>0;
      return {name:'order',args:[row(q),row(w),initial],expected};
    });
  });
}

if(import.meta.main)await testZipFold();
