import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {Backend,checkedBook} from '../compiler/backend.ts';
import {emitStorage} from '../compiler/storage.ts';
import {storageCodec} from '../sdk/storage.ts';
import {buildProgram} from '../scripts/program.ts';
import {compileSbf} from '../scripts/build.ts';
// Fixtures for tests/cpi_frame_sbf.rs: the unchanged checked executor probe
// under an isolated stem, and a test-only callee that records what it observes.
export async function testCpiFrame() {
  const schema=new Backend(await checkedBook('tests/cpi.bend')).emit(['process']).schema;
  const layout=emitStorage(schema,'process');
  assert.equal(layout.interface.version,1);assert.equal(layout.interface.effects,'cpi-v1');
  assert.equal(layout.interface.stateBytes,25);assert.equal(layout.interface.instructionBytes,434);
  assert.match(layout.c,/metas\[j\]\.index==0 && transfers\[i\]\.metas\[j\]\.writable\) return 22;/);
  // A read-only, signing meta for managed state index 0 is a canonical client value.
  const ctr=(constructor:string,fields:Record<string,any>={})=>({constructor,fields});
  const key=ctr('../sdk/context.Key',Object.fromEntries('abcdefgh'.split('').map(k=>[k,0])));
  const meta=(index:number,writable:boolean,signer:boolean)=>ctr('../sdk/cpi.Meta',{index,key,writable,signer});
  const effect=ctr('../sdk/cpi.Invoke',{program:2,program_key:key,length:1,
    data:ctr('../sdk/cpi.Bytes64',Object.fromEntries('abcdefghijklmnop'.split('').map(k=>[k,k==='a'?1:0]))),count:2,
    accounts:ctr('../sdk/cpi.Metas',Object.fromEntries('abcdefgh'.split('').map((k,i)=>
      [k,i===0?meta(4,true,false):i===1?meta(0,false,true):meta(0,false,false)])))});
  const bytes=storageCodec(schema,layout.interface).instruction(ctr('Run',{effect}));
  assert.equal(bytes.length,434);
  assert.deepEqual([...bytes.subarray(114,120)],[0,4,0,0,0,0]);assert.deepEqual([...bytes.subarray(152,154)],[1,0]);
  assert.deepEqual([...bytes.subarray(154,160)],[0,0,0,0,0,0]);assert.deepEqual([...bytes.subarray(192,194)],[0,1]);
  const manifest=await buildProgram('tests/cpi.bend','process','build/cpi-frame');
  compileSbf('tests/cpi-frame-callee.c','build/cpi-frame-callee');
  const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const files=(names:string[])=>Object.fromEntries(names.map(file=>[file,hash(file)]));
  fs.writeFileSync('build/cpi-frame-report.json',JSON.stringify({version:1,abi:1,effects:'cpi-v1',
    stateBytes:layout.interface.stateBytes,instructionBytes:layout.interface.instructionBytes,
    compiler:manifest.compiler,platformTools:manifest.platformTools,bendCommit:manifest.bendCommit,
    sources:files(['tests/cpi.bend','tests/cpi-frame-callee.c','tests/cpi-frame.ts','tests/cpi_frame_sbf.rs',
      'compiler/storage.ts','runtime/bend_cpi.h','runtime/cpi_abi.h','runtime/solana_min.h']),
    artifacts:files(['build/cpi-frame.c','build/cpi-frame.so','build/cpi-frame.interface.json',
      'build/cpi-frame.manifest.json','build/cpi-frame-callee.so'])},null,2)+'\n');
  console.log('CPI state-frame adapter and observing callee built; hashes in build/cpi-frame-report.json');
}
if(import.meta.main)await testCpiFrame();
