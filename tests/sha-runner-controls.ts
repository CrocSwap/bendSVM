import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {prepareShaRunner,verifyShaRunner} from './sha-runner.ts';

export function checkShaRunnerControls(prepared:ReturnType<typeof prepareShaRunner>,directory:string) {
  fs.mkdirSync(directory,{recursive:false});
  const refusals:string[]=[];
  const reject=(name:string,receipt:typeof prepared.receipt,reason:RegExp)=>{
    assert.throws(()=>verifyShaRunner(receipt),reason);refusals.push(name);
  };
  const executable=prepared.receipt.executable.path,original=fs.readFileSync(executable);
  const changed=Buffer.from(original);changed[changed.length-1]^=1;
  try {
    fs.writeFileSync(executable,changed);
    reject('changed-retained-executable',prepared.receipt,/retained runner bytes changed/);
  } finally {fs.writeFileSync(executable,original);}
  verifyShaRunner(prepared.receipt);
  const log=Object.keys(prepared.receipt.evidenceHashes).find(file=>file.endsWith('build.stdout'))!;
  const originalLog=fs.readFileSync(log);
  try {
    fs.appendFileSync(log,'changed build transcript\n');
    reject('changed-build-transcript',prepared.receipt,/runner input changed/);
  } finally {fs.writeFileSync(log,originalLog);}
  verifyShaRunner(prepared.receipt);
  const sourceHashes={...prepared.receipt.sourceHashes};delete sourceHashes[Object.keys(sourceHashes)[0]];
  reject('omitted-source-binding',{...prepared.receipt,sourceHashes},/runner source inventory changed/);
  const file=Object.keys(prepared.receipt.sourceHashes).find(file=>file.endsWith('Cargo.lock'))!;
  reject('wrong-lock-binding',{...prepared.receipt,sourceHashes:{...prepared.receipt.sourceHashes,[file]:'0'.repeat(64)}},/runner input changed/);
  reject('wrong-runtime',{...prepared.receipt,runtime:'LiteSVM 0.0.0' as any},/LiteSVM 0.7.1/);
  verifyShaRunner(prepared.receipt);
  const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const report={passed:true,refusals,restored:true,runnerReceipt:{file:prepared.file,sha256:hash(prepared.file)},
    sourceHashes:{[import.meta.path]:hash(import.meta.path)}};
  const reportFile=path.join(directory,'report.json');fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
  return {report,file:reportFile};
}

if(import.meta.main) {
  const directory=path.resolve('build/sha-runner-controls/run-'+crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
  const prepared=prepareShaRunner(path.join(directory,'runner'));
  const controls=checkShaRunnerControls(prepared,path.join(directory,'controls'));
  console.log(JSON.stringify({passed:true,report:controls.file,refusals:controls.report.refusals.length}));
}
