import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {digest,inventory} from '../verification/check-acyclic-lowering.ts';
const id=randomUUID(),directory='build/acyclic-lowering';
const receipt='build/acyclic-lowering-test.json';
if(fs.existsSync(receipt))fs.renameSync(receipt,`${receipt}.${id}.previous`);
fs.mkdirSync(directory,{recursive:true});
const before=inventory(),rows=[];
for(const [name,executable,script,report] of [
 ['receipts',process.execPath,'tests/acyclic-lowering-receipt.ts','receipt-controls.json'],
 ['inputs',process.execPath,'tests/acyclic-lowering-input.ts','input-controls.json'],
 ['C grammar and guards',process.env.PYTHON??'python3','tests/acyclic-c-audit.py','audit-report.json'],
 ['native expressions',process.env.PYTHON??'python3','tests/acyclic-c-differential.py','expression-differential.json'],
 ['native counterexamples',process.execPath,'tests/acyclic-native-replay.ts','replay-report.json'],
]) {
 const output=`${directory}/${report}`;
 if(fs.existsSync(output))fs.renameSync(output,`${output}.${id}.previous`);
 const result=spawnSync(executable,script.endsWith('.py')?['-B',script]:[script],{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
 const log=`${directory}/${report}.${id}.log`;fs.writeFileSync(log,(result.stdout??'')+(result.stderr??''));
 assert.ifError(result.error);assert.equal(result.signal,null,`${name}: signal`);assert.equal(result.status,0,`${name}: see ${log}`);
 const bytes=fs.readFileSync(output);assert.equal(JSON.parse(bytes.toString()).passed,true);
 assert.deepEqual(inventory(),before,`${name}: source drift`);
 rows.push({name,script,report:output,sha256:digest(bytes),log,logSha256:digest(fs.readFileSync(log))});
 console.log(`${name}: passed`);
}
const pending=`${directory}/${id}-accepted.json`;
fs.writeFileSync(pending,JSON.stringify({passed:true,runId:id,sourceHashes:before,checks:rows},null,2)+'\n',{flag:'wx'});
fs.renameSync(pending,receipt);
