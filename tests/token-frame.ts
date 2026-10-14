import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {checkTokenFrame,validateTokenFrame} from '../verification/check-token-frame.ts';
const output='build/token-frame-refinement.json',testReport='build/token-frame-test.json';
const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.rmSync(testReport,{force:true});checkTokenFrame();
const modelProcess=spawnSync(process.env.PYTHON??'python3',['-B','tests/token-frame-model.py'],{encoding:'utf8',timeout:60000});
fs.writeFileSync('build/token-frame-model.log',(modelProcess.stdout??'')+(modelProcess.stderr??''));
assert.ifError(modelProcess.error);assert.equal(modelProcess.signal,null);assert.equal(modelProcess.status,0,modelProcess.stderr||modelProcess.stdout);
const modelReport='build/token-frame-model-test.json',model=JSON.parse(fs.readFileSync(modelReport,'utf8'));
assert.equal(model.passed,true);assert.equal(model.endToEndVerified,false);assert.equal(model.z3,'5.1.0');
assert.deepEqual(model.coverage,{result:'unsat'});
assert.deepEqual(model.faults.map((r:any)=>[r.name,r.result]),[['narrow-token-span','sat'],['omit-last-account','sat'],['allow-decimals-write','sat']]);
assert.deepEqual(model.refusals.map((r:any)=>r.name),['scalar-data','flat-data','wrong-size-width','empty-prefix']);
for(const row of model.refusals)assert.ok(row.reason);
for(const [file,digest] of Object.entries(model.sourceHashes))assert.equal(hash(file),digest);

const bytes=fs.readFileSync(output),good=JSON.parse(bytes.toString());
const mutations:[string,(r:any)=>void][]=[
 ['narrowed-frame',r=>r.frameSpec.token.spans=[[64,72]]],
 ['missing-path',r=>r.stablePaths.pop()],
 ['duplicate-path',r=>r.stablePaths[1]=r.stablePaths[0]],
 ['unknown-path',r=>r.stablePaths[0].guard='unknown'],
 ['lost-frame-proof',r=>r.frameClaims[0].result='sat'],
 ['lost-frame-control',r=>r.frameClaims[2].result='unsat'],
 ['missing-witness',r=>r.mutablePredicates.pop()],
 ['incomplete-accounts',r=>r.mutablePredicates[0].witness.accounts.pop()],
 ['wrong-runtime',r=>r.inputs['runtime/token.h']='0'.repeat(64)],
 ['missing-module',r=>delete r.inputs['verification/token_frame.py']],
 ['wrong-write-byte',r=>r.mutablePredicates[0].byte=0],
 ['numeric-wide-value',r=>r.mutablePredicates[0].witness.amount=1],
];
const refusals=[];
for(const [name,mutate] of mutations) {
 const changed=structuredClone(good);mutate(changed);
 assert.throws(()=>validateTokenFrame(changed),undefined,name);refusals.push(name);
}
const processes=[];
for(const [name,python] of [['nonzero-python','false'],['missing-python','/nonexistent/token-frame-python']]) {
 fs.writeFileSync(output,bytes);
 const child=spawnSync(process.execPath,['verification/check-token-frame.ts'],{env:{...process.env,PYTHON:python},encoding:'utf8',timeout:30000});
 assert.ifError(child.error);assert.equal(child.signal,null);assert.notEqual(child.status,0);
 assert(!fs.existsSync(output),'process failure left success');
 const log=`build/token-frame-${name}.log`;fs.writeFileSync(log,(child.stdout??'')+(child.stderr??''));
 processes.push({name,exitCode:child.status,log,logSha256:hash(log)});
}
checkTokenFrame();
const child=spawnSync(process.env.PYTHON??'python3',['-B','tests/token-frame-native.py'],{encoding:'utf8',timeout:120000});
fs.writeFileSync('build/token-frame-native.log',(child.stdout??'')+(child.stderr??''));
assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,child.stderr||child.stdout);
const native='build/token-frame-native/fresh-receipt.json',receipt=JSON.parse(fs.readFileSync(native,'utf8'));
assert.equal(receipt.passed,true);assert.deepEqual(receipt.actual,[0,24,0,26]);assert.equal(receipt.proofReportSha256,hash(output));
validateTokenFrame(JSON.parse(fs.readFileSync(output,'utf8')));
fs.writeFileSync(testReport,JSON.stringify({passed:true,modelReportSha256:hash(modelReport),reportRefusals:refusals,processControls:processes,proofReportSha256:hash(output),nativeReceiptSha256:hash(native),testSha256:hash('tests/token-frame.ts'),nativeCheckerSha256:hash('tests/token-frame-native.py')},null,2)+'\n');
console.log('Token frame: 12 report refusals, 2 process controls and native mutable-predicate witnesses passed');
