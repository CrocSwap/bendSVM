import fs from 'node:fs';
import assert from 'node:assert/strict';
import {Backend,checkedBook} from '../compiler/backend.ts';
import {emitStorage} from '../compiler/storage.ts';
import {storageCodec} from '../sdk/storage.ts';
import {buildProgram} from '../scripts/program.ts';
import {compileSbf} from '../scripts/build.ts';
import { assertReproducibleProgramBuilds, programBuildSnapshot } from './program-build-reproducibility.ts';
export async function testCpi() {
  const schema=new Backend(await checkedBook('tests/cpi.bend')).emit(['process']).schema;
  const layout=emitStorage(schema,'process').interface;
  assert.equal(layout.effects,'cpi-v1');assert.equal(layout.instructionBytes,434);
  const client=storageCodec(schema,layout);
  const ctr=(constructor:string,fields:Record<string,any>={})=>({constructor,fields});
  const key=ctr('../sdk/context.Key',Object.fromEntries('abcdefgh'.split('').map(k=>[k,0])));
  const meta=ctr('../sdk/cpi.Meta',{index:0,key,writable:false,signer:false});
  const effect=ctr('../sdk/cpi.Invoke',{program:2,program_key:key,length:5,
    data:ctr('../sdk/cpi.Bytes64',Object.fromEntries('abcdefghijklmnop'.split('').map(k=>[k,k==='a'?768:0]))),count:0,
    accounts:ctr('../sdk/cpi.Metas',Object.fromEntries('abcdefgh'.split('').map(k=>[k,meta])))});
  const bytes=client.instruction(ctr('Run',{effect}));
  assert.equal(bytes.length,434);assert.deepEqual([...bytes.subarray(0,7)],[1,0,1,2,0,0,0]);
  const broken=structuredClone(schema);const metas=broken.types.find(t=>t.name==='../sdk/cpi.Meta')!;
  if(metas.kind!=='adt')throw new Error('Expected meta');metas.variants[0].fields[2].type='U32';
  assert.throws(()=>emitStorage(broken,'process'),/Invalid CPI scalar/);
  const first=await buildProgram('tests/cpi.bend','process','build/cpi');
  const dir=fs.mkdtempSync('build/cpi-reproduce-');
  try {
    const reproduced=await buildProgram('tests/cpi.bend','process',`${dir}/cpi`);
    assertReproducibleProgramBuilds(programBuildSnapshot(first,'build/cpi'),programBuildSnapshot(reproduced,`${dir}/cpi`));
  }
  finally {fs.rmSync(dir,{recursive:true,force:true});}
  compileSbf('tests/cpi-callee.c','build/cpi-callee');
  for(const stem of ['cpi-pair','cpi-multi','cpi-multi-3','cpi-multi-4']) {
    const config=stem==='cpi-pair'?undefined:`tests/${stem}.layout.json`;
    const first=await buildProgram(`tests/${stem}.bend`,'process',`build/${stem}`,config);
    const dir=fs.mkdtempSync('build/cpi-reproduce-');
    try {
      const reproduced=await buildProgram(`tests/${stem}.bend`,'process',`${dir}/${stem}`,config);
      assertReproducibleProgramBuilds(programBuildSnapshot(first,`build/${stem}`),programBuildSnapshot(reproduced,`${dir}/${stem}`));
    }
    finally {fs.rmSync(dir,{recursive:true,force:true});}
  }
  console.log('CPI schema/client checks and reproducible caller/callee build passed');
}
