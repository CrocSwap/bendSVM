import assert from 'node:assert/strict';
import type {WireValue} from '../sdk/wire.ts';
import {testPure, type PureCase} from './pure.ts';

export const treeFoldRoots=['order4','order32','compound32','indexed4','indexed32','indexed_compound32'];

export async function testTreeFold(file='tests/tree-fold.bend',stem='build/tree-fold') {
  await testPure(file,treeFoldRoots,stem,schema=>{
    const types=new Map(schema.types.map(t=>[t.name,t]));
    const cases:PureCase[]=[];
    function ctor(name:string,tag:number,values:WireValue[]):WireValue {
      const t=types.get(name)!;assert(t.kind==='adt');const variant=t.variants[tag];
      assert.equal(variant.fields.length,values.length);
      return {constructor:variant.name,fields:Object.fromEntries(variant.fields.map((f,i)=>[f.name,values[i]]))};
    }
    function sumType(name:string):string {
      const t=types.get(name)!;assert(t.kind==='adt');
      return t.variants[0].fields[2].type;
    }
    function storage(name:string,values:WireValue[]):WireValue {
      if(values.length===1)return values[0];
      const t=types.get(name)!;assert(t.kind==='adt');const fields=t.variants[0].fields;
      const half=values.length/2;
      return ctor(name,0,[storage(fields[0].type,values.slice(0,half)),storage(fields[1].type,values.slice(half))]);
    }
    for(const name of treeFoldRoots) {
      const wide=name.includes('compound'),capacity=name.endsWith('4')?4:32;
      const exp=schema.exports.find(e=>e.name===name)!;
      const vt=types.get(exp.args[1])!;assert(vt.kind==='adt');
      const st=vt.variants[0].fields[1].type;
      let element=st;
      for(let n=capacity;n>1;n/=2) {const t=types.get(element)!;assert(t.kind==='adt');element=t.variants[0].fields[0].type;}
      const initial=wide?ctor(exp.args[2],0,[0xffffffff,7,
        ctor(sumType(exp.args[2]),0,[0xfffffff0,0xffffffff])]):0xffffffff;
      const words=Array.from({length:capacity},(_,i)=>wide?
        (BigInt((Math.imul(i+1,65537))>>>0)<<32n)|BigInt((Math.imul(i+1,7919)+0x80000000)>>>0):
        BigInt((Math.imul(i+1,7919)+0x80000000)>>>0));
      function add(length:number,fuel:number,values:bigint[]) {
        let valid=length<=capacity&&fuel===length,digest=0xffffffff,count=7,sum=0xfffffffffffffff0n;
        if(valid)for(const word of values.slice(0,length)) {
          if(word===(wide?0xffffffffffffffffn:0xffffffffn)){valid=false;break;}
          const lo=Number(word&0xffffffffn),hi=Number(word>>32n);
          digest=(Math.imul(digest,131)+lo+Math.imul(hi,17))>>>0;
          count=(count+1)>>>0;sum=(sum+word)&0xffffffffffffffffn;
        }
        const encoded=values.map(v=>wide?ctor(element,0,[Number(v&0xffffffffn),Number(v>>32n)]):Number(v));
        const result=types.get(exp.result)!;assert(result.kind==='adt');
        const value=wide?ctor(result.variants[1].fields[0].type,0,[digest,count,
          ctor(sumType(result.variants[1].fields[0].type),0,
            [Number(sum&0xffffffffn),Number(sum>>32n)])]):digest;
        cases.push({name,args:[fuel,ctor(exp.args[1],0,[length,storage(st,encoded)]),initial],
          expected:ctor(exp.result,valid?1:0,valid?[value]:[])});
      }
      for(const length of [...Array(capacity+2).keys(),0xffffffff])for(let fuel=0;fuel<=64;fuel++) {
        if(name.startsWith('indexed')&&fuel!==length&&![0,capacity,64].includes(fuel))continue;
        add(length,fuel,words);
      }
      // A failure at any active leaf must remain failed even with later valid
      // leaves. The same sentinel outside the prefix must be ignored.
      for(let at=0;at<capacity;at++)for(const length of [at,at+1,capacity]) {
        const values=[...words];values[at]=wide?0xffffffffffffffffn:0xffffffffn;
        add(length,length,values);
      }
    }
    return cases;
  });
}

if(import.meta.main)await testTreeFold();
