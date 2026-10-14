import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {main as loader} from './check-loader.ts';
import {main as collection} from './check-collection-root.ts';
export async function main(){
 const base='build/collection-entry',receipt=`${base}/fresh-receipt.json`,attempt=`${base}/prerequisites/${randomUUID()}`;
 fs.mkdirSync(attempt,{recursive:true});if(fs.existsSync(receipt))fs.renameSync(receipt,`${attempt}/previous.json`);
 await loader();await collection();
 const child=spawnSync(process.env.PYTHON??'python3',['-B','verification/collection_entry/qualification/controller.py'],{encoding:'utf8',timeout:600000,maxBuffer:8*1024*1024});
 fs.writeFileSync(`${attempt}/entry.log`,(child.stdout??'')+(child.stderr??''));assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,`${attempt}/entry.log`);
 assert.ok(fs.existsSync(receipt),'missing entry receipt');return JSON.parse(fs.readFileSync(receipt,'utf8'));
}
if(import.meta.main)await main();
