import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {wireCodec,type WireValue} from '../../sdk/wire.ts';
import type {RuntimeSchema} from '../../compiler/schema.ts';

/** Accepted hashes and rejected lengths; malformed canonical tags are separate controls. */
export function makePackedCases(schema:RuntimeSchema,messageType:string,resultType:string) {
  const codec=wireCodec(schema);
  const type=(name:string)=>{const value=schema.types.find(item=>item.name===name);assert(value);return value;};
  const construct=(name:string,next:()=>number):WireValue=>{
    const value=type(name);
    if(value.kind==='u32')return next();
    assert(value.kind==='adt'&&value.variants.length===1);
    const variant=value.variants[0];
    return {constructor:variant.name,fields:Object.fromEntries(variant.fields.map(field=>[field.name,construct(field.type,next)]))};
  };
  const cases:{name:string;wire:number[];expected:number[]}[]=[];
  function add(name:string,length:number,active:Buffer,poison:number) {
    const packed=Buffer.alloc(160,poison);active.copy(packed);
    let index=0;
    const message=construct(messageType,()=>index++===0?length:packed.readUInt32LE((index-2)*4));
    assert.equal(index,41);
    const encoded=codec.encode(messageType,message);assert.equal(encoded.length,204);
    const result=type(resultType);assert(result.kind==='adt'&&result.variants.length===2);
    const accepted=length<=151,variant=result.variants[accepted?1:0];
    const output:{constructor:string;fields:Record<string,WireValue>}={constructor:variant.name,fields:{}};
    if(accepted) {
      const digest=crypto.createHash('sha256').update(active).digest();let word=0;
      output.fields[variant.fields[0].name]=construct(variant.fields[0].type,()=>digest.readUInt32BE(word++*4));
      assert.equal(word,8);
    }
    const expected=[...codec.encode(resultType,output)];assert.equal(expected.length,34);
    cases.push({name,wire:[1,...encoded],expected});
  }
  for(let length=0;length<=151;length++)for(const poison of [0,255])add(
    `length-${length}-poison-${poison}`,length,
    Buffer.from(Array.from({length},(_,index)=>(128+index*37+length*11)&255)),poison,
  );
  add('abc',3,Buffer.from('abc'),165);
  for(const length of [152,160,0xffffffff])add('rejected-'+length,length,Buffer.alloc(0),255);
  assert.equal(cases.length,308);
  return cases;
}
