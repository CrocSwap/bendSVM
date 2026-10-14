import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {checkCpiCaller} from '../verification/check-cpi-caller.ts';
import {digest,inventory} from '../verification/check-acyclic-lowering.ts';

// Fresh qualification, semantic/native controls, process failures, and restoration.
const python=process.env.PYTHON??'python3';
const output='build/cpi-caller/focused.json';
const receipt='build/cpi-caller/fresh-receipt.json';
fs.rmSync(output,{force:true});fs.rmSync(output+'.pending',{force:true});
let qualified=checkCpiCaller();
const initial=qualified;
const controls=path.join(path.dirname(initial.reportArtifact),'controls');fs.mkdirSync(controls);
const stages:any[]=[];
function run(name:string,command:string,args:string[],timeout=180000) {
 const log=path.join(controls,name+'.log'),fd=fs.openSync(log,'wx');
 let child:ReturnType<typeof spawnSync>;
 try{child=spawnSync(command,args,{stdio:['ignore',fd,fd],timeout});}finally{fs.closeSync(fd);}
 assert.ifError(child.error);assert.equal(child.signal,null,name);assert.equal(child.status,0,name+' failed: '+log);
 stages.push({name,log,sha256:digest(fs.readFileSync(log))});
}
const input=initial.inputArtifact,profiles=initial.profileArtifact,report=initial.reportArtifact;
run('callbacks',python,['-B','tests/multi-adapter-callbacks.py',input,path.join(controls,'callbacks.json')]);
run('obligations',python,['-B','tests/cpi-caller-obligation-controls.py',input,path.join(controls,'obligations.json')]);
run('fallback',python,['-B','tests/cpi-caller-fallback-controls.py',path.join(controls,'fallback.json')]);
run('assertions',python,['-B','tests/cpi-caller-assertions.py',path.join(controls,'assertions.json')]);
run('custody',python,['-B','tests/cpi-caller-custody-controls.py',path.join(controls,'custody.json')]);
run('custody-binding',python,['-B','tests/cpi-caller-custody-binding.py',input,path.join(controls,'custody-binding.json')]);
run('custody-native',python,['-B','tests/cpi-caller-custody-native.py',path.join(controls,'custody-native')]);
for(const name of ['pruning-reuse','binding-domain','binding-domain-lemma'])
 run(name,python,['-B',`tests/cpi-caller-${name}-controls.py`,controls]);
for(const name of ['binding','extraction','root'])
 run(name,python,['-B',`tests/cpi-caller-${name}-controls.py`,input,controls]);
run('invalid-profile',process.execPath,['tests/cpi-caller-invalid-profile.ts',input,profiles,path.join(controls,'invalid-second-profile.json')]);
run('native-caller',python,['-B','tests/cpi-caller-native.py',input,profiles,path.join(controls,'invalid-second-profile.json'),controls]);
run('native-root',process.execPath,['tests/cpi-caller-root-native.ts',input,path.join(controls,'root-controls.json'),path.join(controls,'root-native')]);
run('reports',python,['-B','tests/cpi-caller-reports.py',report,input,path.join(controls,'reports.json')]);
// Start from a real completed receipt for each failure control, then require
// retirement. Restore by running qualification again, never by copying success.
const saved=fs.readFileSync(receipt);fs.writeFileSync(path.join(controls,'before-process-controls.json'),saved);
const signal=path.join(controls,'terminate-child.sh');fs.writeFileSync(signal,'#!/bin/sh\nkill -TERM $$\n',{mode:0o755});
const failures=[];
for(const [name,executable,expected] of [['missing-python','/no-such-cpi-caller-python','ENOENT'],['empty-success','/usr/bin/true','audit.json'],['nonzero','/usr/bin/false','caller failed'],['signal',path.resolve(signal),'caller signal']]) {
 fs.writeFileSync(receipt,saved);
 const child=spawnSync(process.execPath,['verification/check-cpi-caller.ts'],{env:{...process.env,PYTHON:executable},encoding:'utf8',timeout:180000});
 assert.ifError(child.error);assert.equal(child.signal,null);assert.notEqual(child.status,0);
 const text=(child.stdout??'')+(child.stderr??'');assert(text.includes(expected),text);
 assert(!fs.existsSync(receipt));assert(!fs.existsSync(receipt+'.pending'));
 const log=path.join(controls,'process-'+name+'.log');fs.writeFileSync(log,text);failures.push({name,log,sha256:digest(text)});
}
qualified=checkCpiCaller();
for(const [name,h] of Object.entries(inventory()))assert.equal(qualified.sourceHashes[name],h,'source drift');
assert.deepEqual(qualified.sourceHashes,initial.sourceHashes,'source drift across focused workflow');
const evidence=['callbacks.json','obligations.json','fallback.json','assertions.json','custody.json','custody-binding.json','custody-native/report.json','pruning-reuse-controls.json','binding-domain-controls.json','binding-domain-lemma-controls.json','binding-controls.json','extraction-controls.json','root-controls.json','full-native-caller.json','root-native/native-replay-report.json','reports.json'].map(name=>{
 const artifact=path.join(controls,name),bytes=fs.readFileSync(artifact),value=JSON.parse(bytes.toString());
 assert.equal(value.passed,true,name);
 for(const [p,h] of Object.entries(value.inputs??{}))assert.equal(digest(fs.readFileSync(p)),h,name+' input drift');
 return {artifact,sha256:digest(bytes)};
});
assert.equal(JSON.parse(fs.readFileSync(path.join(controls,'reports.json'),'utf8')).refusals.length,129);
const readControl=(name:string)=>JSON.parse(fs.readFileSync(path.join(controls,name),'utf8'));
const obligations=readControl('obligations.json');
assert.equal(obligations.defaultReportEquivalentExceptTime,true);
assert.deepEqual(obligations.controls,['false-final-obligation-refused','callback-unknown-propagates']);
assert.equal(obligations.groups.length,21);assert.equal(new Set(obligations.groups).size,21);
const assertionControls=readControl('assertions.json');
assert.deepEqual(assertionControls.cases.map((x:any)=>[x.source,x.exitCode,x.reason]),
 ['verification/cpi_caller/caller.py','tests/cpi-caller-obligation-controls.py','tests/cpi-caller-custody-controls.py','tests/cpi-caller-custody-binding.py','tests/cpi-caller-custody-native.py','tests/cpi-caller-fallback-controls.py'].map(source=>[source,1,'assertions required']));
const fallback=readControl('fallback.json');
assert.deepEqual(fallback.cases.map((x:any)=>[x.reduced,x.full,x.passed]),[
 ['unsat',null,true],['sat',true,true],['sat',false,true],['unknown',true,true],['unknown',false,true],['unknown','error',true],
]);
const custody=readControl('custody.json');
assert.equal(custody.successEquivalence,'unsat');assert.equal(custody.successWitness,'sat');
assert.deepEqual(custody.controls.map((x:any)=>[x.name,x.result]),[
 ['wrong-seed-account','refused'],['wrong-custody-account','refused'],['wrong-prefix','refused'],
 ['wrong-seed-length','refused'],['ignored-syscall-failure','refused'],['wrong-model-custody-binding','sat'],
]);
assert(custody.controls[5].countermodel);
const custodyBinding=readControl('custody-binding.json');
assert.deepEqual(custodyBinding.rows.map((x:any)=>x.name),['cpi-2','cpi-3','cpi-4']);
for(const row of custodyBinding.rows) {
 assert.deepEqual(row.cases.map((x:any)=>[x.fault,x.result]),[
  [null,'unsat'],['missing-result','sat'],['wrong-bump','sat'],['wrong-seed','sat'],['wrong-program','sat'],['wrong-custody','sat'],
 ]);
 assert.equal(row.cases[0].successWitness,'sat');
 for(const fault of row.cases.slice(1))assert(Object.keys(fault.countermodel).length>0);
}
const nativeCustody=readControl('custody-native/report.json');
assert.equal(nativeCustody.baselineScenarios,5);
assert.deepEqual(nativeCustody.rows.map((x:any)=>[x.name,x.exitCode,x.expectedExitCode]),[
 ['baseline',0,0],['wrong-seed-account',40,40],['truncated-key-equality',41,41],
]);
for(const row of nativeCustody.rows) {
 assert.equal(digest(fs.readFileSync(path.join(controls,'custody-native',row.name))),row.executableSha256);
 assert.equal(digest(fs.readFileSync(path.join(controls,'custody-native',row.name+'.header'))),row.headerSha256);
}
assert.equal(digest(fs.readFileSync(path.join(controls,'custody-native/harness.c'))),nativeCustody.harnessSha256);

const result={passed:true,endToEndVerified:false,initial,restored:qualified,stages,failures,evidence};
fs.writeFileSync(output+'.pending',JSON.stringify(result,null,2)+'\n');fs.renameSync(output+'.pending',output);
console.log('CPI caller focused checks, failure controls and fresh restoration passed');
