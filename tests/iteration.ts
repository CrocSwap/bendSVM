import fs from 'node:fs';
import assert from 'node:assert/strict';
import { testPure, type PureCase } from './pure.ts';
import { model } from '../verification/model.ts';
import { Backend, checkedBook } from '../compiler/backend.ts';
import { wireCodec } from '../sdk/wire.ts';

export const iterationRoots=['count','swaps','toggle','rotate'];
export async function testIteration() {
  await testPure('tests/iteration.bend',iterationRoots,'build/iteration',schema=>{
    const codec=wireCodec(schema);
    assert.throws(()=>codec.encode('Nat',65));
    assert.throws(()=>codec.decode('Nat',new Uint8Array([65,0,0,0])));
    const state=(left:number,right:number)=>({constructor:'State',fields:{left,right}});
    const cases:PureCase[]=[];
    for(let fuel=0;fuel<=64;fuel++) {
      for(const n of [0,0xffffffff])cases.push({name:'count',args:[fuel,n],expected:(n+fuel)>>>0});
      cases.push({name:'swaps',args:[fuel,state(17,42)],expected:fuel%2?state(42,17):state(17,42)},
        {name:'rotate',args:[fuel,17,42],expected:fuel%2?state(42,17):state(17,42)},
        {name:'toggle',args:[fuel,false],expected:Boolean(fuel%2)});
    }
    return cases;
  });
  const source=fs.readFileSync('build/iteration.h','utf8');
  assert.equal((source.match(/for \(;;\)/g)||[]).length,4,'Four specializations must emit actual loops');
  fs.writeFileSync('build/iteration.model.json',JSON.stringify(await model('tests/iteration.bend',iterationRoots))+'\n');
  const dir=fs.mkdtempSync('build/iteration-negative-');
  try {
    for(const [name,body,pattern] of [
      ['growing','def grow(n: Nat) -> Nat:\n  Succ{n}\n',/Runtime Nat construction/],
      ['oversized','def large() -> Nat:\n  65n\n',/fuel limit/],
      ['wrong-fuel','def wrong(+first: Nat, second: Nat, value: U32) -> U32:\n  match second:\n    case Zero{}:\n      value\n    case Succ{pred}:\n      wrong(first, pred, value)\n',/same Nat fuel/],
      ['non-tail','def recur(n: Nat) -> U32:\n  match n:\n    case Zero{}:\n      0\n    case Succ{pred}:\n      U32.add(1, recur(pred))\n',/Recursion is unsupported/],
    ] as const) {
      const file=`${dir}/${name}.bend`;fs.writeFileSync(file,'import Base\n'+body);
      const root=name==='growing'?'grow':name==='oversized'?'large':name==='wrong-fuel'?'wrong':'recur';
      await assert.rejects(async()=>new Backend(await checkedBook(file)).emit([root]),pattern);
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
if(import.meta.main)await testIteration();
