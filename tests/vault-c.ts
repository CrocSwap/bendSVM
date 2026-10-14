import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {digest,inventory} from '../verification/check-acyclic-lowering.ts';
const id=randomUUID(),receipt='build/vault-c-test.json',directory=`build/vault-c-tests/${id}`;
if(fs.existsSync(receipt))fs.renameSync(receipt,`${receipt}.${id}.previous`);
fs.mkdirSync(directory,{recursive:true});const before=inventory(),rows=[];
for(const [script,report] of [['tests/vault-c-receipt.ts','build/vault-c-controls.json'],['tests/vault-c-input.ts','build/vault-c-input-controls.json'],['tests/vault-c-replay.ts','build/vault-c-replay/replay-report.json']]) {
 if(fs.existsSync(report))fs.renameSync(report,`${report}.${id}.previous`);
 const result=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
 const log=`${directory}/${rows.length}.log`;fs.writeFileSync(log,(result.stdout??'')+(result.stderr??''));
 assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0,`failed ${script}; see ${log}`);
 const raw=fs.readFileSync(report);assert.equal(JSON.parse(raw.toString()).passed,true);assert.deepEqual(inventory(),before,'source drift');
 rows.push({script,report,sha256:digest(raw),log,logSha256:digest(fs.readFileSync(log))});console.log(`${script}: passed`);
}
const pending=`${directory}/accepted.json`;fs.writeFileSync(pending,JSON.stringify({passed:true,runId:id,sourceHashes:before,checks:rows},null,2)+'\n',{flag:'wx'});fs.renameSync(pending,receipt);
