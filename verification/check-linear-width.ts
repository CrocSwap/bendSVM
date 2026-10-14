import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {model} from './model.ts';
import {inventory,digest,acceptProcess} from './check-acyclic-lowering.ts';
import {main as checkSigned} from './check-signed-lowering.ts';
export function boundInventory(){return {...inventory(),...Object.fromEntries(['benchmarks/linear.bend','benchmarks/linear-wide.bend'].map(p=>[p,digest(fs.readFileSync(p))]))};}
export async function main(){
 const base='build/linear-width',id=randomUUID(),run=`${base}/runs/${id}`,receipt=`${base}/fresh-receipt.json`;
 fs.mkdirSync(run,{recursive:true});if(fs.existsSync(receipt))fs.renameSync(receipt,`${run}/previous.json`);
 await checkSigned();const sdkReceiptPath='build/signed-lowering/fresh-receipt.json',sdkReceipt=JSON.parse(fs.readFileSync(sdkReceiptPath,'utf8'));
 const before=boundInventory(),original='benchmarks/linear-wide.bend',candidate='benchmarks/linear.bend';
 const inputs=[
  ['input.json',{source:await model(original,['product'])}],
  ['candidate-model.json',{original:await model(original,['product','advance_if']),candidate:await model(candidate,['product','../sdk/signed.add32_wrap','advance_if'])}],
  ['composition-model.json',{original:await model(original,['product','advance_if','fold_rows','finish_sum','linear']),candidate:await model(candidate,['product','../sdk/signed.add32_wrap','advance_if','fold_rows','finish_sum','linear'])}],
 ] as const;
 assert.deepEqual(boundInventory(),before);
 for(const [name,models] of inputs)fs.writeFileSync(`${run}/${name}`,JSON.stringify({runId:id,...models,sourceHashes:before},null,2)+'\n',{flag:'wx'});
 fs.writeFileSync(`${run}/sdk-receipt.json`,JSON.stringify(sdkReceipt,null,2)+'\n',{flag:'wx'});
 const python=process.env.PYTHON??'python3',stages=[];
 for(const [script,output] of [['linear_width_product.py','report.json'],['linear_width_step.py','candidate-proof.json'],['linear_width_composition.py','composition-proof.json']]){
  const result=spawnSync(python,['-B',`verification/${script}`,run],{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
  const log=`${run}/${script}.log`;fs.writeFileSync(log,(result.stdout??'')+(result.stderr??''));const report=acceptProcess(result,`${run}/${output}`);assert.equal(report.passed,true);
  stages.push({artifact:`${run}/${output}`,sha256:digest(fs.readFileSync(`${run}/${output}`)),log,logSha256:digest(fs.readFileSync(log))});
 }
 const result=spawnSync(python,['-B','verification/linear_width_report.py',run],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
 fs.writeFileSync(`${run}/inventory.log`,(result.stdout??'')+(result.stderr??''));assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0,result.stderr);
 assert.deepEqual(boundInventory(),before);
 const accepted={passed:true,endToEndVerified:false,runId:id,sourceHashes:before,inputs:inputs.map(([name])=>({artifact:`${run}/${name}`,sha256:digest(fs.readFileSync(`${run}/${name}`))})),sdkReceiptArtifact:`${run}/sdk-receipt.json`,sdkReceiptSha256:digest(fs.readFileSync(`${run}/sdk-receipt.json`)),stages,inventoryLog:`${run}/inventory.log`,inventoryLogSha256:digest(fs.readFileSync(`${run}/inventory.log`))};
 fs.writeFileSync(`${run}/accepted.json`,JSON.stringify(accepted,null,2)+'\n',{flag:'wx'});fs.renameSync(`${run}/accepted.json`,receipt);console.log('Fresh linear signed-width source composition passed');
}
if(import.meta.main)await main();
