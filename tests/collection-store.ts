import fs from 'node:fs';
import assert from 'node:assert/strict';
import {buildProgram} from '../scripts/program.ts';
import {compileSbf} from '../scripts/build.ts';
import {collectionStorageCodec} from '../sdk/collection-storage.ts';

export async function testCollectionStore() {
  compileSbf('tests/cpi-callee.c','build/cpi-callee');
  await buildProgram('tests/collection-cpi.bend','process','build/collection-cpi','tests/collection-cpi.json');
  await buildProgram('tests/collection-record.bend','process','build/collection-record','tests/collection-record.json');
  await buildProgram('tests/collection-store.bend','process','build/collection-store','tests/collection-store.json');
  const schema=JSON.parse(fs.readFileSync('build/collection-store.schema.json','utf8'));
  const layout=JSON.parse(fs.readFileSync('build/collection-store.interface.json','utf8'));
  const codec=collectionStorageCodec(schema,layout),key=new Uint8Array(32).fill(7);
  const data=new Uint8Array(codec.allocationBytes(4096));data.set(layout.collection.header);data.set(key,24);
  const view=new DataView(data.buffer);view.setUint32(20,300,true);view.setUint32(56+299*4,0xffffffff,true);
  assert.deepEqual(codec.metadata(data,key),{length:300,capacity:4096});
  assert.deepEqual(codec.window(data,key,299,1),[0xffffffff]);
  assert.deepEqual(codec.window(data,key,300,0),[]);
  for(const [start,count] of [[300,1],[0xffffffff,1],[0,3],[-1,1],[0,-1]])assert.throws(()=>codec.window(data,key,start,count));
  assert.throws(()=>codec.metadata(data,new Uint8Array(32)));
  assert.throws(()=>collectionStorageCodec(schema,{...layout,collection:{...layout.collection,stride:8}}));
  assert.deepEqual([...codec.instruction({constructor:'Append',fields:{value:17}},'initialize')],[0,0,17,0,0,0,0,0,0,0]);
  console.log('Collection storage build and client checks passed');
}
if(import.meta.main)await testCollectionStore();
