import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {digest,inventory} from './check-acyclic-lowering.ts';
import {exportIssuanceAdapter} from './export-issuance-adapter.ts';
const directory='build/issuance-adapter',receipt=`${directory}/fresh-receipt.json`;
export async function checkIssuanceAdapter() {
 fs.mkdirSync(directory,{recursive:true});fs.rmSync(receipt,{force:true});fs.rmSync(receipt+'.pending',{force:true});
 const before=inventory(),runId=randomUUID(),run=`${directory}/run-${runId}`;
 try {
  await exportIssuanceAdapter(run);
  const raw=fs.readFileSync(`${run}/input.json`),input=JSON.parse(raw.toString());
  assert.deepEqual(input.sourceHashes,before);
  const stages=[];
  for(const [name,file] of [['semantics','verification/issuance_adapter_semantic.py'],['inventory','verification/issuance_adapter_report.py']]) {
   const child=spawnSync(process.env.PYTHON??'python3',['-B',file],{env:{...process.env,BRIDGE_DIR:run},encoding:'utf8',timeout:900000,maxBuffer:1<<24});
   const log=`${run}/${name}.log`;fs.writeFileSync(log,(child.stdout??'')+(child.stderr??''));
   assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,`${name} failed; ${log}`);
   stages.push({name,log,logSha256:digest(fs.readFileSync(log)),exitCode:0});
  }
  assert.deepEqual(inventory(),before,'source drift');assert.deepEqual(fs.readFileSync(`${run}/input.json`),raw,'input drift');
  for(const [file,hash] of Object.entries(input.artifactHashes))assert.equal(digest(fs.readFileSync(file)),hash,`artifact drift: ${file}`);
  const report=JSON.parse(fs.readFileSync(`${run}/semantic-report.json`,'utf8'));
  assert.equal(report.passed,true);assert.equal(report.endToEndVerified,false);assert.equal(report.inputSha256,digest(raw));
  const result={passed:true,endToEndVerified:false,runId,inputArtifact:`${run}/input.json`,inputSha256:digest(raw),reportArtifact:`${run}/semantic-report.json`,reportSha256:digest(fs.readFileSync(`${run}/semantic-report.json`)),sourceHashes:before,stages};
  fs.writeFileSync(receipt+'.pending',JSON.stringify(result,null,2)+'\n');fs.renameSync(receipt+'.pending',receipt);
  console.log('Issuance adapter: actual C, codecs, helpers and commit claims plus two semantic fault controls passed');
  return result;
 } catch(error) {fs.rmSync(receipt,{force:true});fs.rmSync(receipt+'.pending',{force:true});throw error;}
}
if(import.meta.main)await checkIssuanceAdapter();
