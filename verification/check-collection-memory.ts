import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {main as entry} from './check-collection-entry.ts';
export async function main(){
 const base='build/collection-memory',receipt=`${base}/fresh-receipt.json`,attempt=`${base}/prerequisites/${randomUUID()}`;
 fs.mkdirSync(attempt,{recursive:true});if(fs.existsSync(receipt))fs.renameSync(receipt,`${attempt}/previous.json`);
 await entry();
 const child=spawnSync(process.env.PYTHON??'python3',['-B','verification/collection_memory/qualification/controller.py'],{encoding:'utf8',timeout:900000,maxBuffer:8*1024*1024});
 fs.writeFileSync(`${attempt}/memory.log`,(child.stdout??'')+(child.stderr??''));assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,`${attempt}/memory.log`);
 assert.ok(fs.existsSync(receipt),'missing memory receipt');return JSON.parse(fs.readFileSync(receipt,'utf8'));
}
if(import.meta.main)await main();
