import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {digest,inventory} from './check-acyclic-lowering.ts';

const directory='build/cpi-caller';
const receipt=path.join(directory,'fresh-receipt.json');
const python=process.env.PYTHON??'python3';
const hash=(p:string)=>digest(fs.readFileSync(p));
function sources() {
 const files=inventory();
 for(const entry of fs.readdirSync('runtime',{withFileTypes:true})) {
  if(entry.isFile())files[path.join('runtime',entry.name)]=hash(path.join('runtime',entry.name));
 }
 files[import.meta.path]=hash(import.meta.path);
 const auditor='verification/cpi_caller/audit.py';files[auditor]=hash(auditor);
 return files;
}
export function checkCpiCaller() {
 fs.mkdirSync(directory,{recursive:true});
 fs.rmSync(receipt,{force:true});fs.rmSync(receipt+'.pending',{force:true});
 const runId=randomUUID(),run=path.join(directory,'run-'+runId);
 fs.mkdirSync(run);const sourceHashes=sources();
 const stages:any[]=[];
 function child(name:string,command:string,args:string[],timeout:number) {
  const log=path.join(run,name+'.log'),fd=fs.openSync(log,'wx');
  let result:ReturnType<typeof spawnSync>;
  try {result=spawnSync(command,args,{stdio:['ignore',fd,fd],timeout});}
  finally {fs.closeSync(fd);}
  stages.push({name,command,args,exitCode:result.status,signal:result.signal,log,logSha256:hash(log),error:result.error?.message??null});
  fs.writeFileSync(path.join(run,'stages.json'),JSON.stringify(stages,null,2)+'\n');
  assert.ifError(result.error);assert.equal(result.signal,null,name+' signal');
  assert.equal(result.status,0,name+' failed; see '+log);
 }
 try {
  const input=path.join(run,'fixtures/input.json'),profiles=path.join(run,'profiles.json'),report=path.join(run,'report.json'),audit=path.join(run,'audit.json');
  child('export',process.execPath,['verification/export-cpi-caller.ts',path.dirname(input)],180000);
  child('profiles',process.execPath,['verification/cpi-caller-profiles.ts',input,profiles],30000);
  child('caller',python,['-B','verification/cpi_caller/caller.py',input,profiles,report],1800000);
  child('audit',python,['-B','verification/cpi_caller/audit.py',input,profiles,report,audit],30000);
  const evidence=JSON.parse(fs.readFileSync(audit,'utf8'));
  assert.equal(evidence.passed,true);assert.equal(evidence.inputSha256,hash(input));
  assert.equal(evidence.profileSha256,hash(profiles));assert.equal(evidence.reportSha256,hash(report));
  assert.equal(evidence.fixtures,3);assert.equal(evidence.callerClaims,18);
  assert.equal(evidence.rootClaims,3);assert.equal(evidence.custodyClaims,3);assert.equal(evidence.successWitnesses,6);
  assert.deepEqual(sources(),sourceHashes,'source drift during qualification');
  const result={passed:true,endToEndVerified:false,runId,inputArtifact:input,inputSha256:hash(input),profileArtifact:profiles,profileSha256:hash(profiles),reportArtifact:report,reportSha256:hash(report),auditArtifact:audit,auditSha256:hash(audit),sourceHashes,stages};
  fs.writeFileSync(receipt+'.pending',JSON.stringify(result,null,2)+'\n');fs.renameSync(receipt+'.pending',receipt);
  console.log('CPI caller source/C, codec, extraction, custody, validator and commit claims passed');
  return result;
 } catch(error) {
  fs.rmSync(receipt,{force:true});fs.rmSync(receipt+'.pending',{force:true});
  fs.writeFileSync(path.join(run,'failure.json'),JSON.stringify({passed:false,runId,error:String(error),stages},null,2)+'\n');
  throw error;
 }
}
if(import.meta.main)checkCpiCaller();
