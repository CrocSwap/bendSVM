import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
export const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function main() {
 const directory=process.env.NATIVE_BODY_DIR??'build/native-body-lowering';
 const receipt=path.join(directory,'fresh-receipt.json'),runId=randomUUID();
 if(fs.existsSync(receipt))fs.renameSync(receipt,path.join(directory,`previous-wrapper-${runId}.json`));
 fs.mkdirSync(directory,{recursive:true});
 try {
 const result=spawnSync(process.env.PYTHON??'python3',['-B',path.join(import.meta.dir,'check-native-body.py')],{encoding:'utf8',timeout:480000,maxBuffer:8*1024*1024});
 const log=path.join(directory,`driver-${runId}.log`);
 fs.writeFileSync(log,(result.stdout??'')+(result.stderr??'')+(result.error?'\n'+String(result.error):''),{flag:'wx'});
 assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0,`Native body gate failed; ${log}`);
 const accepted=JSON.parse(fs.readFileSync(receipt,'utf8'));
 assert.equal(accepted.passed,true);assert.equal(accepted.endToEndVerified,false);
 for(const [file,h] of Object.entries(accepted.sourceHashes))assert.equal(digest(fs.readFileSync(file)),h,'source drift');
 for(const [file,h] of [[accepted.nativeReceipt,accepted.nativeReceiptSha256],[accepted.bodyReport,accepted.bodyReportSha256]])assert.equal(digest(fs.readFileSync(file)),h,'artifact drift');
 console.log('Fresh source and parsed SBF-C native body proofs passed');
 return {receipt,log};
 } catch(error) {
  if(fs.existsSync(receipt))fs.renameSync(receipt,path.join(directory,`failed-${runId}.json`));
  throw error;
 }
}
if(import.meta.main)main();
