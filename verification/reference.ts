import assert from 'node:assert/strict';
import * as B from '../.deps/bend/bend2/bend.ts';
import type { RuntimeSchema } from '../compiler/schema.ts';
import type { WireValue } from '../sdk/wire.ts';

// Replay a concrete counterexample with the pinned Bend evaluator, independently
// of the symbolic evaluator. Schema names preserve generic constructor identity.
export function evaluateCall(book:B.Book,schema:RuntimeSchema,name:string,args:WireValue[]):WireValue {
  const types=new Map(schema.types.map(t=>[t.name,t]));
  const term=(name:string,value:WireValue):B.HTerm=>{
    const type=types.get(name)!;
    if(name==='Nat') {let t:B.HTerm=B.Ctr('Zero',[]);for(let i=0;i<(value as number);i++)t=B.Ctr('Succ',[t]);return t;}
    if(type.kind==='u32')return B.term_higher(B.u32_to_term(value as number));
    if(type.kind==='bool')return B.Ctr(value?'True':'False',[]);
    assert(typeof value==='object');const v=type.variants.find(v=>v.name===value.constructor)!;
    return B.Ctr(v.sourceName??v.name,v.fields.map(f=>term(f.type,value.fields[f.name])));
  };
  const value=(name:string,t:B.HTerm):WireValue=>{
    const type=types.get(name)!;
    if(name==='Nat') {let n=0;while(t.$==='Ctr'&&t.k==='Succ'){n++;t=t.x[0];}assert(t.$==='Ctr'&&t.k==='Zero');return n;}
    if(type.kind==='u32'){const n=B.u32_from_term(t);assert(n!==null);return n;}
    assert(t.$==='Ctr');
    if(type.kind==='bool')return t.k==='True';
    const v=type.variants.find(v=>(v.sourceName??v.name)===t.k)!;
    return {constructor:v.name,fields:Object.fromEntries(v.fields.map((f,i)=>[f.name,value(f.type,t.x[i])]))};
  };
  const fn=schema.exports.find(f=>f.name===name)!;
  const call=args.reduce<B.HTerm>((f,a,i)=>B.App(f,term(fn.args[i],a)),B.Ref(name));
  return value(fn.result,B.term_snf(book,call));
}
