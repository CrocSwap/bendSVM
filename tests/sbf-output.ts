import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dir,'..'),output=path.join(root,'build/sbf-output-test.json');
const run=path.join(root,'build/sbf-output-tests',randomUUID());fs.mkdirSync(run,{recursive:true});
if(fs.existsSync(output))fs.renameSync(output,path.join(run,'previous.json'));
const hash=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const files=[import.meta.path,path.join(import.meta.dir,'sbf-output.py'),path.join(root,'verification/sbf_output.py'),path.join(root,'verification/sbf_cfg.py')];
const sources=Object.fromEntries(files.map(p=>[p,hash(p)]));
try {
 const child=spawnSync(process.env.PYTHON??'python3',['-B',files[1]],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
 const log=path.join(run,'test.log');fs.writeFileSync(log,(child.stdout??'')+(child.stderr??'')+(child.error?String(child.error):''));
 assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,`Output model checks failed; ${log}`);
 const report=JSON.parse(child.stdout);assert.equal(report.passed,true);assert.equal(report.endToEndVerified,false);
 assert.equal(report.claims.length,6);assert.ok(report.claims.every((c:any)=>c.result==='unsat'));
 assert.equal(new Set(report.claims.map((c:any)=>c.name)).size,6);
 assert.equal(report.integerOraclePrograms,200);assert.equal(report.operationsPerProgram,40);
 assert.equal(report.refusals.length,37);assert.equal(new Set(report.refusals.map((r:any)=>r.name)).size,37);
 assert.equal(report.optimizedPythonRefused,true);assert.equal(report.callerInputsPreserved,true);
 assert.deepEqual(report.inputHashes,Object.fromEntries(files.slice(1).map(p=>[p,sources[p]])));
 assert.deepEqual(Object.fromEntries(files.map(p=>[p,hash(p)])),sources,'output model source drift');
 const accepted=path.join(run,'accepted.json');fs.writeFileSync(accepted,JSON.stringify({...report,wrapperSourceHashes:sources,log,logSha256:hash(log)},null,2)+'\n');fs.renameSync(accepted,output);
 console.log('SBF output model: six algebra checks, 200 byte-memory programs and 37 refusals passed');
} catch(error) {
 fs.writeFileSync(path.join(run,'failure.json'),JSON.stringify({passed:false,error:String(error)},null,2)+'\n');throw error;
}
