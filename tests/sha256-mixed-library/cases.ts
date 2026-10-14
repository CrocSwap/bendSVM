// Reuses the maintained SHA case builders; isolated mixed-program execution.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {wireCodec,type WireValue} from '../../sdk/wire.ts';
import type {RuntimeSchema} from '../../compiler/schema.ts';
function typeBySuffix(schema:RuntimeSchema,suffix:string) {
  const matches=schema.types.filter(type=>type.name.endsWith(suffix));
  assert.equal(matches.length,1,`one emitted schema type ends with ${suffix}`);
  return matches[0];
}

function variantBySuffix(schema:RuntimeSchema,typeName:string,suffix:string) {
  const type=schema.types.find(item=>item.name===typeName);
  assert(type&&type.kind==='adt'&&type.variants,`${typeName} is an ADT`);
  const matches=type.variants.filter(variant=>variant.name===suffix||variant.name.endsWith(`.${suffix}`));
  assert.equal(matches.length,1,`one ${typeName} constructor ends with ${suffix}`);
  return matches[0];
}

function pairTree(schema:RuntimeSchema,typeName:string,leaves:number[],at=0):WireValue {
  const type=schema.types.find(item=>item.name===typeName);
  assert(type,`schema type exists: ${typeName}`);
  if(type.kind==='u32') {
    assert.equal(leaves.length,1,'one byte word per leaf');
    return leaves[at];
  }
  assert(type.kind==='adt'&&type.variants?.length===1,'pair node has one constructor');
  const variant=type.variants[0];
  assert.equal(variant.fields.length,2,'pair node has two children');
  const leafCount=(name:string):number=>{
    const child=schema.types.find(item=>item.name===name)!;
    if(child.kind==='u32')return 1;
    return child.variants![0].fields.reduce((sum,field)=>sum+leafCount(field.type),0);
  };
  const leftCount=leafCount(variant.fields[0].type);
  return {constructor:variant.name,fields:{
    [variant.fields[0].name]:pairTree(schema,variant.fields[0].type,leaves.slice(at,at+leftCount)),
    [variant.fields[1].name]:pairTree(schema,variant.fields[1].type,leaves.slice(at+leftCount)),
  }};
}

function messageValue(schema:RuntimeSchema,messageType:string,length:number,active:number[],inactive:number):WireValue {
  const message=variantBySuffix(schema,messageType,'Message');
  const bytesField=message.fields.find(field=>field.name==='bytes')!;
  const bytesType=schema.types.find(type=>type.name===bytesField.type)!;
  const bytesVariant=variantBySuffix(schema,bytesField.type,'Bytes64');
  const wordsField=bytesVariant.fields.find(field=>field.name==='words')!;
  const slots=Array<number>(64).fill(inactive);
  active.forEach((byte,index)=>slots[index]=byte);
  return {constructor:message.name,fields:{
    length,
    bytes:{constructor:bytesVariant.name,fields:{words:pairTree(schema,wordsField.type,slots)}},
  }};
}

function resultWire(schema:RuntimeSchema,stateType:string,bytes:Buffer|undefined):WireValue {
  const rejected=variantBySuffix(schema,stateType,'Rejected');
  if(!bytes)return {constructor:rejected.name,fields:{}};
  const hashed=variantBySuffix(schema,stateType,'Hashed');
  const digestField=hashed.fields.find(field=>field.name==='digest')!;
  const digestType=schema.types.find(type=>type.name===digestField.type)!;
  const digestVariant=variantBySuffix(schema,digestField.type,'Digest256');
  const words=Object.fromEntries(digestVariant.fields.map((field,index)=>[
    field.name,bytes.readUInt32BE(index*4),
  ]));
  return {constructor:hashed.name,fields:{digest:{constructor:digestVariant.name,fields:words}}};
}

function makeCases(schema:RuntimeSchema,messageType:string,stateType:string) {
  const cases:{name:string;length:number;active:number[];inactive:number;digest?:Buffer}[]=[];
  for(let length=0;length<=55;length++) {
    const active=Array.from({length},(_,index)=>(0x80+index*37+length*11)&255);
    if(length===1)active[0]=0x80;
    if(length===55)active[54]=0xff;
    cases.push({name:`length-${length}`,length,active,inactive:(0xa5000000|(length<<8)|length)>>>0});
  }
  cases.push(
    {name:'high-bytes-128-through-255',length:55,active:Array.from({length:55},(_,i)=>128+((i*17)%128)),inactive:0xffffffff},
    {name:'reject-length-56',length:56,active:Array.from({length:56},(_,i)=>i*3&255),inactive:0xffffffff},
    {name:'reject-length-64',length:64,active:Array.from({length:64},(_,i)=>255-i),inactive:0xffffffff},
    {name:'reject-length-u32-max',length:0xffffffff,active:[],inactive:0xffffffff},
    {name:'reject-active-256-first',length:1,active:[256],inactive:0xffffffff},
    {name:'reject-active-256-last',length:55,active:[...Array.from({length:54},(_,i)=>i),256],inactive:0xffffffff},
    {name:'reject-active-u32-max-first',length:1,active:[0xffffffff],inactive:0xdeadbeef},
    {name:'reject-active-u32-max-last',length:55,active:[...Array.from({length:54},(_,i)=>i),0xffffffff],inactive:0xdeadbeef},
  );
  const codec=wireCodec(schema);
  return cases.map(item=>{
    const message=messageValue(schema,messageType,item.length,item.active,item.inactive);
    const valid=item.length<=55&&item.active.length===item.length&&item.active.every(byte=>byte<=255);
    const digest=valid?crypto.createHash('sha256').update(Buffer.from(item.active)).digest():undefined;
    const encoded=codec.encode(messageType,message);
    return {...item,digest,wire:[1,...encoded],expected:[...codec.encode(stateType,resultWire(schema,stateType,digest))]};
  });
}


export {makeCases};
