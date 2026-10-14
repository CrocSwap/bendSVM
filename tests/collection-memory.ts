import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {main} from '../verification/check-collection-memory.ts';
import {digest} from '../verification/check-acyclic-lowering.ts';
const base='build/collection-memory',output='build/collection-memory-test.json';
if(fs.existsSync(output))fs.renameSync(output,`${output}.${Date.now()}.previous`);
await main();const evidence=[];
for(const [name,script] of [['process','tests/collection-memory-process.py'],['reports','tests/collection-memory-reports.py']]){
 const child=spawnSync(process.env.PYTHON??'python3',['-B',script],{encoding:'utf8',timeout:900000,maxBuffer:8*1024*1024});
 const log=`${base}/${name}.log`;fs.writeFileSync(log,(child.stdout??'')+(child.stderr??''));assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,log);
 const run=child.stdout.trim().split('\n')[0],artifact=`${run}/${name==='process'?'report':'report-controls'}.json`,raw=fs.readFileSync(artifact),report=JSON.parse(raw.toString());assert.equal(report.passed,true);assert.equal(report.controls.length,name==='process'?4:45);
 evidence.push({name,artifact,sha256:digest(raw),log,logSha256:digest(fs.readFileSync(log))});
}
const receipt=JSON.parse(fs.readFileSync(`${base}/fresh-receipt.json`,'utf8'));
fs.writeFileSync(output,JSON.stringify({passed:true,endToEndVerified:false,receipt,evidence},null,2)+'\n');console.log('Collection memory proof, native, process and report checks passed');
