import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {main,digest} from '../verification/check-native-body.ts';
const output='build/native-body-test.json',run=`build/native-body-tests/${randomUUID()}`;
if(fs.existsSync(output))fs.renameSync(output,`${output}.${randomUUID()}.previous`);
fs.mkdirSync(run,{recursive:true});
const sources=['native-body.ts','native-body-process.py','native-body-semantics.py','native-body-division.py','native-body-reports.py'].map(n=>path.join(import.meta.dir,n));
const before=Object.fromEntries(sources.map(p=>[p,digest(fs.readFileSync(p))]));
const initial=main(),initialReceipt=`${run}/initial-receipt.json`;
fs.copyFileSync(initial.receipt,initialReceipt);
const evidence=[];
for(const [name,script] of [['reports','native-body-reports.py'],['semantics','native-body-semantics.py'],['division','native-body-division.py'],['process','native-body-process.py']]) {
 const result=spawnSync(process.env.PYTHON??'python3',['-B',path.join(import.meta.dir,script)],{encoding:'utf8',env:{...process.env,NATIVE_BODY_RECEIPT:path.resolve(initialReceipt)},timeout:300000,maxBuffer:8*1024*1024});
 const log=`${run}/${name}.log`;fs.writeFileSync(log,(result.stdout??'')+(result.stderr??'')+(result.error?'\n'+String(result.error):''));
 assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0,`${name} controls failed; ${log}`);
 const record=JSON.parse(result.stdout);assert.equal(record.passed,true);assert.equal(digest(fs.readFileSync(record.report)),record.sha256);
 evidence.push({name,artifact:record.report,sha256:record.sha256,log,logSha256:digest(fs.readFileSync(log))});
}
const wrapperControls=[];
for(const [name,python,reason] of [['missing-python','/no-such-native-body-python','/no-such-native-body-python'],['zero-without-report','/usr/bin/true','fresh-receipt.json']]) {
 fs.copyFileSync(initialReceipt,initial.receipt);
 const result=spawnSync(process.execPath,[path.join(import.meta.dir,'../verification/check-native-body.ts')],{encoding:'utf8',env:{...process.env,PYTHON:python},timeout:30000,maxBuffer:4*1024*1024});
 const log=`${run}/wrapper-${name}.log`,text=(result.stdout??'')+(result.stderr??'');fs.writeFileSync(log,text);
 assert.ifError(result.error);assert.equal(result.signal,null);assert.notEqual(result.status,0);assert.equal(fs.existsSync(initial.receipt),false);assert.ok(text.includes(reason),'unexpected wrapper refusal');
 wrapperControls.push({name,exitCode:result.status,log,logSha256:digest(fs.readFileSync(log))});
}
const final=main(),receipt=JSON.parse(fs.readFileSync(final.receipt,'utf8'));
assert.deepEqual(Object.fromEntries(sources.map(p=>[p,digest(fs.readFileSync(p))])),before,'test source drift');
const report={passed:true,endToEndVerified:false,receipt,initialReceipt,initialReceiptSha256:digest(fs.readFileSync(initialReceipt)),testSourceHashes:before,evidence,wrapperControls,
 logs:[initial.log,final.log].map(artifact=>({artifact,sha256:digest(fs.readFileSync(artifact))}))};
const pending=`${run}/accepted.json`;fs.writeFileSync(pending,JSON.stringify(report,null,2)+'\n');fs.renameSync(pending,output);
console.log('Native body proofs, report controls, semantic/native replays and process controls passed');
