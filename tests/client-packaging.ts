import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeClientArtifacts,clientSuffixes} from '../compiler/client-artifacts.ts';
import {addressString} from '../sdk/program-client.ts';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bend client portable '));
fs.rmSync('build/client-packaging-report.json',{force:true});
try {
  // Copy only published client artifacts, with no SDK or compiler beside them.
  for(const name of ['collection-store','queue']) {
    const schema=JSON.parse(fs.readFileSync(`build/${name}.schema.json`,'utf8'));
    const layout=JSON.parse(fs.readFileSync(`build/${name}.interface.json`,'utf8'));
    const stem=path.join(dir,name);
    await writeClientArtifacts(stem,schema,layout);
    for(const suffix of clientSuffixes)assert(fs.statSync(stem+suffix).size>0);
  }
  const key=(n:number)=>addressString(new Uint8Array(32).fill(n));
  const {createClient}=await import(path.join(dir,'queue.client.js'));
  const call=createClient(key(9)).instructions.Append({recipient:key(6),amount:17n},
    {state:key(1),actor:key(2),tokenProgram:key(3),custody:key(4),collection:key(5)});
  assert.equal(call.data.length,68);
  assert.deepEqual([...call.data.subarray(35,44)],[0,17,0,0,0,0,0,0,0]);
  fs.writeFileSync(path.join(dir,'types.ts'),`import {createClient} from './queue.client';
const client=createClient('11111111111111111111111111111111');
const accounts={state:'s',actor:'a',tokenProgram:'t',custody:'c',collection:'l'};
client.instructions.Append({recipient:'r',amount:17n},accounts);
client.instructions.Seal({},accounts);
// @ts-expect-error amount is a bigint, not a number
client.instructions.Append({recipient:'r',amount:17},accounts);
// @ts-expect-error missing collection account
client.instructions.Seal({}, {state:'s',actor:'a',tokenProgram:'t',custody:'c'});
// @ts-expect-error unknown instruction
client.instructions.Missing({},accounts);
// @ts-expect-error no fields on Seal
client.instructions.Seal({amount:1},accounts);
const state=client.state(new Uint8Array());
if(state.kind==='Collecting') { const remaining:bigint=state.queue.remaining; const owner:string=state.queue.owner; }
const records=client.collection(new Uint8Array(),'s',0,1).entries;
const amount:bigint=records[0].amount;
const recipient:string=records[0].recipient;
`);
  const tsc=process.env.TSC_JS??path.resolve('node_modules/typescript/lib/tsc.js');
  if(!fs.existsSync(tsc))throw new Error(`Pinned TypeScript compiler missing: ${tsc}; run npm ci`);
  const result=spawnSync('node',[tsc,'--noEmit','--strict','--target','es2022','--module','esnext','--moduleResolution','bundler',path.join(dir,'types.ts')],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const version=spawnSync('node',[tsc,'--version'],{encoding:'utf8'});assert.equal(version.status,0);
  assert.equal(version.stdout.trim(),'Version 5.2.2',`Expected pinned TypeScript 5.2.2, got ${version.stdout}`);
  const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const files=['tests/client-packaging.ts','compiler/client.ts','compiler/client-artifacts.ts',
    'sdk/program-client.ts','sdk/wire.ts','sdk/storage.ts','sdk/multi-storage.ts','sdk/collection-storage.ts','compiler/schema.ts','compiler/diagnostics.ts',
    ...['collection-store','queue'].flatMap(name=>[`build/${name}.schema.json`,`build/${name}.interface.json`])];
  fs.writeFileSync('build/client-packaging-report.json',JSON.stringify({passed:true,typescript:version.stdout.trim(),typescriptSource:process.env.TSC_JS??'node_modules/typescript/lib/tsc.js',compilerSha256:hash(tsc),
    hashes:Object.fromEntries(files.map(file=>[file,hash(file)])),artifacts:Object.fromEntries(['collection-store','queue'].flatMap(name=>clientSuffixes.map(suffix=>[name+suffix,hash(path.join(dir,name+suffix))])))},null,2)+'\n');
  console.log('Portable JavaScript client executed outside the repository; strict TypeScript positive and negative client checks passed');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
