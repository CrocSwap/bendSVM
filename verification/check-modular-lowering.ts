import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {digest,inventory,syntaxCheck,acceptProcess} from './check-acyclic-lowering.ts';
import {fixtures,exportPrograms} from './modular-source.ts';
export async function main() {
 const directory='build/modular-lowering',receipt=`${directory}/fresh-receipt.json`,id=randomUUID(),run=`${directory}/runs/${id}`;
 fs.mkdirSync(run,{recursive:true});
 if(fs.existsSync(receipt))fs.renameSync(receipt,`${run}/previous.json`);
 const before=inventory(),programs=await exportPrograms();
 for(const p of programs)for(const [file,h] of Object.entries(p.sourceHashes))assert.equal(before[path.relative(process.cwd(),file)],h,'unbound source');
 assert.deepEqual(inventory(),before,'source drift while exporting');
 const cSyntax=syntaxCheck(programs,run),input={version:1,runId:id,fixtures,programs,cSyntax,sourceHashes:before};
 const inputPath=`${run}/input.json`,output=`${run}/child.json`;
 fs.writeFileSync(inputPath,JSON.stringify(input,null,2)+'\n',{flag:'wx'});const raw=fs.readFileSync(inputPath);
 const python=process.env.PYTHON??'python3';
 const result=spawnSync(python,['-B','verification/modular_lowering.py',inputPath,output],{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
 fs.writeFileSync(`${run}/proof.log`,(result.stdout??'')+(result.stderr??''));
 const report=acceptProcess(result,output);
 assert.equal(report.passed,true);assert.equal(report.endToEndVerified,false);assert.equal(report.runId,id);assert.equal(report.inputSha256,digest(raw));assert.deepEqual(report.sourceHashes,before);
 const checked=spawnSync(python,['-B','verification/modular_report.py',inputPath,output],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
 fs.writeFileSync(`${run}/inventory.log`,(checked.stdout??'')+(checked.stderr??''));
 assert.ifError(checked.error);assert.equal(checked.signal,null);assert.equal(checked.status,0,'modular report inventory failed');
 assert.deepEqual(fs.readFileSync(inputPath),raw,'input changed');assert.deepEqual(inventory(),before,'source drift during proof');
 const accepted={passed:true,endToEndVerified:false,runId:id,inputArtifact:inputPath,inputSha256:digest(raw),reportArtifact:output,reportSha256:digest(fs.readFileSync(output)),sourceHashes:before,
  logs:['proof.log','inventory.log'].map(name=>({artifact:`${run}/${name}`,sha256:digest(fs.readFileSync(`${run}/${name}`))}))};
 const pending=`${run}/accepted.json`;fs.writeFileSync(pending,JSON.stringify(accepted,null,2)+'\n',{flag:'wx'});fs.renameSync(pending,receipt);
 console.log('Fresh modular source/C gate accepted: five complete closures and six semantic faults');
}
if(import.meta.main)await main();
