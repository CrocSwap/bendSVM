import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {main} from '../verification/check-collection-root.ts';
import {collectionInventory} from '../verification/export-collection-root.ts';
import {digest} from '../verification/check-acyclic-lowering.ts';
const base='build/collection-root',receipt=`${base}/fresh-receipt.json`,output=`${base}/process-controls.json`;
if(fs.existsSync(output))fs.renameSync(output,`${output}.${Date.now()}.previous`);
await main();
const saved=fs.readFileSync(receipt),before=collectionInventory(),rows=[];
const python=process.env.PYTHON??'python3',located=spawnSync(python,['-c','import sys; print(sys.executable)'],{encoding:'utf8'});
assert.ifError(located.error);assert.equal(located.status,0);
const wrapper=path.resolve(`${base}/failure-python`);
fs.writeFileSync(wrapper,`#!${located.stdout.trim()}\nimport os,sys\nargs=sys.argv[1:]\nif 'verification/collection_root_semantic.py' in args:\n mode=os.environ['COLLECTION_FAILURE_MODE']\n if mode=='missing':os.execv('/no-such-collection-python',['/no-such-collection-python']+args)\n if mode=='empty':sys.exit(0)\n if mode=='exit':print('injected collection child exit');sys.exit(42)\n if mode=='optimized':args=['-O']+args\nos.execv(sys.executable,[sys.executable]+args)\n`,{mode:0o755});
for(const [name,env,reason] of [
 ['missing-child',{PYTHON:wrapper,COLLECTION_FAILURE_MODE:'missing'},'/no-such-collection-python'],
 ['empty-report',{PYTHON:wrapper,COLLECTION_FAILURE_MODE:'empty'},'missing fresh child report'],
 ['failed-child',{PYTHON:wrapper,COLLECTION_FAILURE_MODE:'exit'},'injected collection child exit'],
 ['optimized-child',{PYTHON:wrapper,COLLECTION_FAILURE_MODE:'optimized'},'collection root requires assertions'],
] as const){
 fs.writeFileSync(receipt,saved);const old=new Set(fs.readdirSync(`${base}/runs`));
 const result=spawnSync(process.execPath,['verification/check-collection-root.ts'],{env:{...process.env,...env},encoding:'utf8',timeout:1200000,maxBuffer:8*1024*1024});
 const log=`${base}/${name}.log`;fs.writeFileSync(log,(result.stdout??'')+(result.stderr??''));
 assert.ifError(result.error);assert.equal(result.signal,null);assert.notEqual(result.status,0);assert.equal(fs.existsSync(receipt),false);
 const added=fs.readdirSync(`${base}/runs`).filter(n=>!old.has(n));assert.equal(added.length,1);
 const run=`${base}/runs/${added[0]}`,retired=`${run}/previous.json`;assert.deepEqual(fs.readFileSync(retired),saved);
 const logs=fs.readdirSync(run).filter(n=>n.endsWith('.log')).map(n=>`${run}/${n}`);
 assert.ok((fs.readFileSync(log,'utf8')+logs.map(p=>fs.readFileSync(p,'utf8')).join('\n')).includes(reason),name+' wrong failure');
 assert.deepEqual(collectionInventory(),before);
 rows.push({name,exitCode:result.status,retired,retiredSha256:digest(saved),log,logSha256:digest(fs.readFileSync(log)),logs:logs.map(p=>({artifact:p,sha256:digest(fs.readFileSync(p))}))});
}
const accepted=await main();
const reportResult=spawnSync(python,['-B','tests/collection-root-reports.py',path.dirname(accepted.inputArtifact)],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
const log=path.join(path.dirname(accepted.inputArtifact),'report-controls.log');fs.writeFileSync(log,(reportResult.stdout??'')+(reportResult.stderr??''));
assert.ifError(reportResult.error);assert.equal(reportResult.signal,null);assert.equal(reportResult.status,0,log);
assert.deepEqual(collectionInventory(),before);
const controls=path.join(path.dirname(accepted.inputArtifact),'strict-report-controls.json');
fs.writeFileSync(output,JSON.stringify({passed:true,receipt:accepted,processControls:rows,reportControls:{artifact:controls,sha256:digest(fs.readFileSync(controls)),log,logSha256:digest(fs.readFileSync(log))}},null,2)+'\n',{flag:'wx'});
console.log('Collection root process failures, receipt retirement and report controls passed');
