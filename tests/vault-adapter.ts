import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const directory='build/vault-adapter-bridge',receipt=`${directory}/fresh-receipt.json`;
fs.mkdirSync(directory,{recursive:true});
fs.rmSync('build/vault-adapter-test.json',{force:true});
const hash=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(name:string,command:string,args:string[],env:NodeJS.ProcessEnv=process.env) {
 const child=spawnSync(command,args,{env,encoding:'utf8',timeout:1800000,maxBuffer:8*1024*1024});
 const log=`${directory}/test-${name}.log`;fs.writeFileSync(log,(child.stdout??'')+(child.stderr??''));
 return {child,log,logSha256:hash(log)};
}
function positive(name:string,command:string,args:string[]) {
 const result=run(name,command,args);assert.ifError(result.child.error);assert.equal(result.child.signal,null);assert.equal(result.child.status,0,fs.readFileSync(result.log,'utf8'));return {name,log:result.log,logSha256:result.logSha256};
}
const stages=[positive('stage-diagnostics',process.env.PYTHON??'python3',['-B','tests/vault-stage-diagnostics.py']),positive('initial',process.execPath,['verification/check-vault-adapter.ts'])];
const good=fs.readFileSync(receipt);const controls=[];
for(const [name,overrides] of [
 ['nonzero-frontend',{CC:'false'}],['missing-frontend',{CC:'/nonexistent/vault-bridge-clang'}],
 ['missing-python',{PYTHON:'/nonexistent/vault-bridge-python'}],
] as const) {
 fs.writeFileSync(receipt,good);
 const result=run(name,process.execPath,['verification/check-vault-adapter.ts'],{...process.env,...overrides});
 assert.ifError(result.child.error);assert.equal(result.child.signal,null);assert.notEqual(result.child.status,0);
 assert.ok(!fs.existsSync(receipt),'failed process left success receipt');
 controls.push({name,log:result.log,logSha256:result.logSha256,exitCode:result.child.status});
}
stages.push(positive('final',process.execPath,['verification/check-vault-adapter.ts']));
stages.push(positive('inventory',process.env.PYTHON??'python3',['-B','tests/vault-adapter-inventory.py']));
stages.push(positive('semantic-controls',process.env.PYTHON??'python3',['-B','tests/vault-semantic-controls.py']));
stages.push(positive('native-codecs',process.env.PYTHON??'python3',['-B','tests/vault-codec-native.py']));
stages.push(positive('semantic-replay',process.execPath,['tests/vault-semantic-replay.ts']));
stages.push(positive('state-replay',process.execPath,['tests/vault-state-replay.ts']));
stages.push(positive('effect-native',process.env.PYTHON??'python3',['-B','tests/vault-effect-native.py']));
stages.push(positive('token-binding-controls',process.env.PYTHON??'python3',['-B','tests/token-binding-controls.py']));
stages.push(positive('token-validator-native',process.env.PYTHON??'python3',['-B','tests/token-validator-native.py']));
stages.push(positive('token-executor-controls',process.env.PYTHON??'python3',['-B','tests/token-executor-controls.py']));
stages.push(positive('effect-replay',process.execPath,['tests/vault-effect-replay.ts']));
const fresh=JSON.parse(fs.readFileSync(receipt,'utf8'));
for(const [file,expected] of Object.entries(fresh.sourceHashes))assert.equal(hash(file),expected,`source drift: ${file}`);
const inventory=`${directory}/inventory-tests.json`;
fs.writeFileSync('build/vault-adapter-test.json',JSON.stringify({passed:true,stages,controls,receiptSha256:hash(receipt),inventorySha256:hash(inventory),semanticEvidence:Object.fromEntries(['semantic-tests.json','native-report.json','replay-report.json','state-replay-report.json','effect-replay-report.json','effect-native-report.json','token-binding-controls.json','token-native-report.json','token-executor-controls.json'].map(name=>{const file=fresh.input.slice(0,fresh.input.lastIndexOf('/'))+'/'+name;return [file,hash(file)];})),sourceHashes:fresh.sourceHashes},null,2)+'\n');
console.log('Vault adapter bridge: fresh co-validation, 62 report refusals, 8 input refusals, 3 process controls, native codecs and connected witness replay passed');
