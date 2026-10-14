import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {digest} from '../verification/check-acyclic-lowering.ts';
import {main,boundInventory} from '../verification/check-native-handlers.ts';
const directory='build/native-handler-lowering',receipt=`${directory}/fresh-receipt.json`,output='build/native-handler-test.json';
const testFiles=['native-handlers.ts','native-handlers-native.ts','native-handlers-reports.py','native-handlers-division.py','native-handlers-boundaries.py','native-handlers-amm-native.ts','native-handlers-amm-faults.py'].map(n=>path.join(import.meta.dir,n));
const testInventory=()=>Object.fromEntries(testFiles.map(p=>[path.relative(process.cwd(),p),digest(fs.readFileSync(p))]));
const testsBefore=testInventory();
if(fs.existsSync(output))fs.renameSync(output,`${directory}/previous-test-${randomUUID()}.json`);
await main();const saved=fs.readFileSync(receipt),controls=[];
const controlBase=`${directory}/process-controls/${randomUUID()}`;fs.mkdirSync(controlBase,{recursive:true});
for(const [name,overrides,reason] of [
 ['missing-python',{PYTHON:'/no-such-native-handler-python'},'no-such-native-handler-python'],
 ['zero-without-report',{PYTHON:'/usr/bin/true'},'missing fresh child report'],
 ['missing-frontend',{CC:'/no-such-native-handler-clang'},'no-such-native-handler-clang'],
 ['blocked-run-directory',{},'ENOTDIR'],
] as const) {
 const base=`${controlBase}/${name}`;fs.mkdirSync(base);fs.writeFileSync(`${base}/fresh-receipt.json`,saved);
 if(name==='blocked-run-directory')fs.writeFileSync(`${base}/runs`,'blocked setup');
 const result=spawnSync(process.execPath,[path.join(import.meta.dir,'../verification/check-native-handlers.ts')],{env:{...process.env,...overrides,NATIVE_HANDLER_DIR:base},encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
 const log=`${base}/control.log`;fs.writeFileSync(log,(result.stdout??'')+(result.stderr??''));
 assert.ifError(result.error);assert.equal(result.signal,null);assert.notEqual(result.status,0);assert.ok(result.stderr.includes(reason),result.stderr);
 assert.equal(fs.existsSync(`${base}/fresh-receipt.json`),false);
 const previous=fs.readdirSync(base).filter(n=>n.startsWith('previous-')&&n.endsWith('.json'));assert.equal(previous.length,1);assert.deepEqual(fs.readFileSync(`${base}/${previous[0]}`),saved);
 controls.push({name,exitCode:result.status,log,logSha256:digest(fs.readFileSync(log)),priorEvidence:`${base}/${previous[0]}`,priorSha256:digest(saved)});
}
await main();const accepted=JSON.parse(fs.readFileSync(receipt,'utf8')),run=path.dirname(accepted.reportArtifact),evidence=[];
for(const [name,executable,script,artifact] of [
 ['reports',process.env.PYTHON??'python3','native-handlers-reports.py','report-controls.json'],
 ['division',process.env.PYTHON??'python3','native-handlers-division.py','division-controls.json'],
 ['boundaries',process.env.PYTHON??'python3','native-handlers-boundaries.py','boundary-controls.json'],
 ['native',process.execPath,'native-handlers-native.ts','native-root.json'],
 ['amm-faults',process.env.PYTHON??'python3','native-handlers-amm-faults.py','amm-faults.json'],
 ['amm-native',process.execPath,'native-handlers-amm-native.ts','amm-native.json'],
]) {
 const file=path.join(import.meta.dir,script),result=spawnSync(executable,script.endsWith('.py')?['-B',file]:[file],{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
 const log=`${run}/${name}.log`;fs.writeFileSync(log,(result.stdout??'')+(result.stderr??''));
 assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0,fs.readFileSync(log,'utf8'));
 const report=`${run}/${artifact}`;assert.equal(JSON.parse(fs.readFileSync(report,'utf8')).passed,true);
 evidence.push({artifact:report,sha256:digest(fs.readFileSync(report)),log,logSha256:digest(fs.readFileSync(log))});
}
assert.deepEqual(boundInventory(),accepted.sourceHashes,'source drift');assert.deepEqual(testInventory(),testsBefore,'test source drift');
assert.equal(digest(fs.readFileSync(accepted.inputArtifact)),accepted.inputSha256);assert.equal(digest(fs.readFileSync(accepted.reportArtifact)),accepted.reportSha256);
const pending=`${run}/focused-accepted.json`;fs.writeFileSync(pending,JSON.stringify({passed:true,receipt:accepted,testSourceHashes:testsBefore,processControls:controls,evidence},null,2)+'\n',{flag:'wx'});fs.renameSync(pending,output);
console.log('Native handlers: fresh proofs, report/boundary/process controls and full-entrypoint native replays passed');
