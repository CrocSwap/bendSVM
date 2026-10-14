import fs from 'node:fs';
import assert from 'node:assert/strict';
import {Backend,checkedBook} from '../compiler/backend.ts';
import {emitStorage} from '../compiler/storage.ts';
import {buildProgram} from '../scripts/program.ts';
import {multiStorageCodec} from '../sdk/multi-storage.ts';
import {wireCodec} from '../sdk/wire.ts';
import { assertReproducibleProgramBuilds, programBuildSnapshot } from './program-build-reproducibility.ts';
export async function testMultiStorage() {
  const emitted=new Backend(await checkedBook('tests/multi-storage.bend')).emit(['process']);
  const generated=emitStorage(emitted.schema,'process',{stateAccounts:['left','right']});
  assert.equal(generated.interface.version,2);
  if(generated.interface.version!==2 || !('stateAccounts' in generated.interface))throw new Error('Expected multi-storage');
  const layout=generated.interface,client=multiStorageCodec(emitted.schema,layout),codec=wireCodec(emitted.schema);
  assert.deepEqual(layout.stateAccounts.map(a=>a.index),[0,2]);
  assert.deepEqual(layout.stateAccounts.map(a=>a.bindingBytes),[0,32]);
  assert.notDeepEqual(layout.stateAccounts[0].header,layout.stateAccounts[1].header,'Same-type fields need distinct headers');
  const cell={constructor:'Cell',fields:{value:42}};
  const encoded=codec.encode('Cell',cell);
  const primaryKey=Uint8Array.from({length:32},(_,i)=>i);
  const right=new Uint8Array([...layout.stateAccounts[1].header,...primaryKey,...encoded]);
  assert.deepEqual(JSON.parse(JSON.stringify(client.account('right',right,primaryKey))),cell);
  assert.throws(()=>client.account('right',right),/primary state binding/);
  assert.throws(()=>client.account('right',right,new Uint8Array(32)),/primary state binding/);
  assert.deepEqual([...client.instruction({constructor:'Set',fields:{left:3,right:4}},'initialize')],[0,0,3,0,0,0,4,0,0,0]);
  assert.throws(()=>client.account('absent',encoded),/field\/header\/size/);
  const bad=structuredClone(layout);bad.stateAccounts[1].index=0;
  assert.throws(()=>multiStorageCodec(emitted.schema,bad),/account layout/);
  const unbound=structuredClone(layout);unbound.stateAccounts[1].bindingBytes=0;
  assert.throws(()=>multiStorageCodec(emitted.schema,unbound),/account layout/);
  for(const fields of [['left'],['left','left'],['right','left'],['left','right','extra']])
    assert.throws(()=>emitStorage(emitted.schema,'process',{stateAccounts:fields}),/2–4 field record/);
  const first=await buildProgram('tests/multi-storage.bend','process','build/multi-storage','tests/multi-storage.layout.json');
  assert.ok(first.inputs['tests/multi-storage.layout.json']);
  const dir=fs.mkdtempSync('build/multi-reproduce-');
  try {
    const reproduced=await buildProgram('tests/multi-storage.bend','process',`${dir}/multi-storage`,'tests/multi-storage.layout.json');
    assertReproducibleProgramBuilds(programBuildSnapshot(first,'build/multi-storage'),programBuildSnapshot(reproduced,`${dir}/multi-storage`));
  }
  finally {fs.rmSync(dir,{recursive:true,force:true});}
  for (const count of [3,4]) {
    const stem=`multi-storage-${count}`,source=`tests/${stem}.bend`,config=`tests/${stem}.layout.json`;
    const schema=new Backend(await checkedBook(source)).emit(['process']).schema;
    const options=JSON.parse(fs.readFileSync(config,'utf8'));
    const generated=emitStorage(schema,'process',options);
    if (!('stateAccounts' in generated.interface)) throw new Error('Expected multi-state layout');
    const layout=generated.interface,client=multiStorageCodec(schema,layout),codec=wireCodec(schema);
    assert.deepEqual(layout.stateAccounts.map(a=>a.index),[0,...Array.from({length:count-1},(_,i)=>i+2)]);
    assert.equal(new Set(layout.stateAccounts.map(a=>JSON.stringify(a.header))).size,count,'Field positions must have distinct headers');
    const primaryKey=Uint8Array.from({length:32},(_,j)=>j+1);
    for(const [i,a] of layout.stateAccounts.entries()) {
      const data=codec.encode(a.type,{constructor:a.type,fields:{value:i+10}});
      const full=new Uint8Array([...a.header,...(i===0?[]:primaryKey),...data]);
      assert.equal((client.account(a.field,full,primaryKey) as any).fields.value,i+10);
      assert.throws(()=>client.account(layout.stateAccounts[(i+1)%count].field,full,primaryKey),/header\/size/);
    }
    const build=await buildProgram(source,'process',`build/${stem}`,config);
    const temp=fs.mkdtempSync('build/multi-reproduce-');
    try {
      const reproduced=await buildProgram(source,'process',`${temp}/${stem}`,config);
      assertReproducibleProgramBuilds(programBuildSnapshot(build,`build/${stem}`),programBuildSnapshot(reproduced,`${temp}/${stem}`));
    }
    finally {fs.rmSync(temp,{recursive:true,force:true});}
  }
  console.log('Multi-storage codec/layout and reproducible public build passed');
  for(const count of [2,3,4]) {
    const stem=`multi-token-${count}`,source=`tests/${stem}.bend`,config=`tests/${stem}.layout.json`;
    const first=await buildProgram(source,'process',`build/${stem}`,config);
    const layout=JSON.parse(fs.readFileSync(`build/${stem}.interface.json`,'utf8'));
    assert.equal(layout.effects,'token-v1');
    assert.deepEqual(layout.stateAccounts.map((a:any)=>a.index),[0,...Array.from({length:count-1},(_,i)=>i+4)]);
    assert.equal(layout.minimumAccounts,count+3);assert.equal(layout.maximumAccounts,12);
    const dir=fs.mkdtempSync('build/multi-token-reproduce-');
    try {
      const reproduced=await buildProgram(source,'process',`${dir}/${stem}`,config);
      assertReproducibleProgramBuilds(programBuildSnapshot(first,`build/${stem}`),programBuildSnapshot(reproduced,`${dir}/${stem}`));
    }
    finally {fs.rmSync(dir,{recursive:true,force:true});}
  }
}
