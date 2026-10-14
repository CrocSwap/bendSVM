import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {checkCpiPhysical,physicalSources} from '../verification/check-cpi-physical.ts';
import {digest} from '../verification/check-acyclic-lowering.ts';

// Complete qualification, actual child failures, preserved previous evidence,
// then a fresh restoration. A zero-exit child without evidence cannot qualify.
const directory='build/cpi-physical',receipt=path.join(directory,'fresh-receipt.json');
const focused=path.join(directory,'focused.json');
fs.mkdirSync(directory,{recursive:true});
const run=path.join(directory,'focused-'+randomUUID());fs.mkdirSync(run);
if(fs.existsSync(focused))fs.renameSync(focused,path.join(run,'previous-focused.json'));
fs.rmSync(focused+'.pending',{force:true});
try {
 const initial=checkCpiPhysical(),saved=fs.readFileSync(receipt);
 const signal=path.join(run,'terminate-child.sh');
 fs.writeFileSync(signal,'#!/bin/sh\nkill -TERM $$\n',{mode:0o755});
 const failures:any[]=[];
 for(const [name,executable,expected] of [
  ['missing-python','/no-such-cpi-physical-python','ENOENT'],
  ['empty-success','/usr/bin/true','ENOENT'],
  ['nonzero','/usr/bin/false','dag failed'],
  ['signal',path.resolve(signal),'dag signal'],
 ]) {
  const previousRuns=new Set(fs.readdirSync(directory).filter(x=>x.startsWith('run-')));
  const previousComponents=new Set(fs.readdirSync('build/cpi-physical-frame').filter(x=>x.startsWith('run-')));
  fs.writeFileSync(receipt,saved);
  const child=spawnSync(process.execPath,['verification/check-cpi-physical.ts'],{
   env:{...process.env,PYTHON:executable},encoding:'utf8',timeout:180000,maxBuffer:1024*1024});
  const log=path.join(run,'process-'+name+'.log');
  fs.writeFileSync(log,(child.stdout??'')+(child.stderr??''));
  assert.ifError(child.error);assert.equal(child.signal,null);assert.notEqual(child.status,0);
  assert(!fs.existsSync(receipt));assert(!fs.existsSync(receipt+'.pending'));
  const created=fs.readdirSync(directory).filter(x=>x.startsWith('run-')&&!previousRuns.has(x));
  assert.equal(created.length,1);
  const failedRun=path.join(directory,created[0]);
  assert.deepEqual(fs.readFileSync(path.join(failedRun,'previous.json')),saved,'prior evidence must survive');
  const failure=JSON.parse(fs.readFileSync(path.join(failedRun,'failure.json'),'utf8'));
  assert.equal(failure.passed,false);assert.equal(failure.stages.length,1);
  assert.equal(failure.stages[0].name,'component');assert.notEqual(failure.stages[0].exitCode,0);
  const nestedLog=failure.stages[0].log;
  assert(fs.readFileSync(nestedLog,'utf8').includes(expected),'wrong child failure: '+name);
  const componentRuns=fs.readdirSync('build/cpi-physical-frame').filter(x=>x.startsWith('run-')&&!previousComponents.has(x));
  assert.equal(componentRuns.length,1,'missing preserved component failure');
  const nestedRun=path.join('build/cpi-physical-frame',componentRuns[0]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(nestedRun,'failure.json'),'utf8')).passed,false);
  failures.push({name,exitCode:child.status,run:failedRun,componentRun:nestedRun,
   expectedReason:expected,artifacts:Object.fromEntries([log,nestedLog,path.join(failedRun,'previous.json'),
    path.join(failedRun,'failure.json'),path.join(nestedRun,'failure.json')].map(p=>[p,digest(fs.readFileSync(p))]))});
 }
 const restored=checkCpiPhysical();
 for(const qualified of [initial,restored])
  assert.equal(digest(fs.readFileSync(qualified.componentArtifact)),qualified.componentSha256,'preserved component receipt drift');
 assert.deepEqual(restored.sourceHashes,initial.sourceHashes,'source drift across focused workflow');
 assert.deepEqual(physicalSources(),initial.sourceHashes,'source inventory drift');
 const result={passed:true,endToEndVerified:false,initial,restored,failures,
  scope:'Fresh maintained CPI physical qualification with process failure retirement, artifact preservation and actual fresh restoration. Conditional source/C/helper/physical model, not an SBF or transaction rollback theorem.'};
 fs.writeFileSync(focused+'.pending',JSON.stringify(result,null,2)+'\n');fs.renameSync(focused+'.pending',focused);
 console.log('CPI physical qualification, process failure controls and fresh restoration passed');
}catch(error){
 fs.rmSync(focused,{force:true});fs.rmSync(focused+'.pending',{force:true});
 fs.writeFileSync(path.join(run,'failure.json'),JSON.stringify({passed:false,error:String(error)},null,2)+'\n');
 throw error;
}
