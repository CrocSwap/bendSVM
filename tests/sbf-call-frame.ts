import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {main} from '../verification/check-sbf-call-frame.ts';
const base=path.resolve(process.env.SBF_FRAME_OUTPUT??'build/sbf-call-frame'),output='build/sbf-call-frame-test.json';
const logs=path.join(base,'test-controls',randomUUID());fs.mkdirSync(logs,{recursive:true});
if(fs.existsSync(output))fs.renameSync(output,path.join(logs,'previous.json'));
const hash=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const modelChild=spawnSync(process.env.PYTHON??'python3',['-B','tests/sbf-call-frame-model.py'],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
const modelLog=path.join(logs,'model.log');fs.writeFileSync(modelLog,(modelChild.stdout??'')+(modelChild.stderr??''));
assert.ifError(modelChild.error);assert.equal(modelChild.signal,null);assert.equal(modelChild.status,0,modelLog);
const modelReport=JSON.parse(modelChild.stdout);assert.equal(modelReport.passed,true);assert.equal(modelReport.endToEndVerified,false);
assert.equal(modelReport.positives.length,3);assert.equal(modelReport.refusals.length,14);assert.equal(modelReport.optimizedPythonRefused,true);
for(const [p,h] of Object.entries(modelReport.inputHashes))assert.equal(hash(p),h);
await main();const evidence=[];
for(const [name,script,count] of [['process','tests/sbf-call-frame-process.py',4],['reports','tests/sbf-call-frame-reports.py',30]] as const){
 const child=spawnSync(process.env.PYTHON??'python3',['-B',script],{env:{...process.env,SBF_FRAME_OUTPUT:base},encoding:'utf8',timeout:900000,maxBuffer:8*1024*1024});
 const log=path.join(logs,name+'.log');fs.writeFileSync(log,(child.stdout??'')+(child.stderr??'')+(child.error?String(child.error):''));
 assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,log);
 const summary=JSON.parse(child.stdout),report=JSON.parse(fs.readFileSync(summary.report,'utf8'));
 assert.equal(summary.passed,true);assert.equal(report.passed,true);assert.equal(report.controls.length,count);
 evidence.push({name,artifact:summary.report,sha256:hash(summary.report),log,logSha256:hash(log)});
}
const receipt=JSON.parse(fs.readFileSync(path.join(base,'fresh-receipt.json'),'utf8'));
for(const stem of ['input','manifest','accepted'])assert.equal(hash(receipt[stem]),receipt[stem+'Sha256']);
const accepted=path.join(logs,'accepted.json');fs.writeFileSync(accepted,JSON.stringify({passed:true,endToEndVerified:false,receipt,evidence,model:{...modelReport,log:modelLog,logSha256:hash(modelLog)}},null,2)+'\n');fs.renameSync(accepted,output);
console.log('SBF call-frame proof, footprint, four process controls and 30 report refusals passed');
