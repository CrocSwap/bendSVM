import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {digest,inventory,syntaxCheck,acceptProcess} from './check-acyclic-lowering.ts';
import {exportPrograms} from './native-handler-source.ts';
import {BEND_COMMIT} from '../scripts/build.ts';
const localFiles=['acyclic_c.py','modular_c.py','native_mul32.py','native_divmod.py','native-handler-source.ts','native_handler_child.py','native_handler_report.py','check-native-handlers.ts'];
export function boundInventory() {
 const local=localFiles.map(name=>path.relative(process.cwd(),path.join(import.meta.dir,name)));
 return {...inventory(),...Object.fromEntries(local.map(p=>[p,digest(fs.readFileSync(p))]))};
}
export async function main() {
 const directory=process.env.NATIVE_HANDLER_DIR??'build/native-handler-lowering';
 const receipt=`${directory}/fresh-receipt.json`,runId=randomUUID(),run=`${directory}/runs/${runId}`;
 // Preserve old evidence and retire success before run-directory setup can fail.
 if(fs.existsSync(receipt))fs.renameSync(receipt,`${directory}/previous-${runId}.json`);
 fs.mkdirSync(run,{recursive:true});
 const before=boundInventory(),data=await exportPrograms();
 for(const p of data.programs)for(const [file,h] of Object.entries(p.sourceHashes))assert.equal(before[path.relative(process.cwd(),file)],h,'unbound source');
 assert.deepEqual(boundInventory(),before,'source drift while exporting');
 const cSyntax=syntaxCheck(data.programs,run);
 const input={version:1,bendCommit:BEND_COMMIT,runId,...data,cSyntax,sourceHashes:before};
 const inputPath=`${run}/input.json`,output=`${run}/child.json`;
 fs.writeFileSync(inputPath,JSON.stringify(input,null,2)+'\n',{flag:'wx'});const raw=fs.readFileSync(inputPath);
 const python=process.env.PYTHON??'python3';
 const child=spawnSync(python,['-B',path.join(import.meta.dir,'native_handler_child.py'),inputPath,output],{encoding:'utf8',timeout:600000,maxBuffer:4*1024*1024});
 fs.writeFileSync(`${run}/proof.log`,(child.stdout??'')+(child.stderr??''),{flag:'wx'});
 const report=acceptProcess(child,output),reportBytes=fs.readFileSync(output);
 assert.equal(report.passed,true);assert.equal(report.endToEndVerified,false);assert.equal(report.runId,runId);assert.equal(report.inputSha256,digest(raw));assert.deepEqual(report.sourceHashes,before);
 const checked=spawnSync(python,['-B',path.join(import.meta.dir,'native_handler_report.py'),inputPath,output],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
 fs.writeFileSync(`${run}/inventory.log`,(checked.stdout??'')+(checked.stderr??''),{flag:'wx'});
 assert.ifError(checked.error);assert.equal(checked.signal,null);assert.equal(checked.status,0,'native-handler report validation failed');
 assert.deepEqual(fs.readFileSync(inputPath),raw,'input changed');assert.deepEqual(fs.readFileSync(output),reportBytes,'report changed');
 assert.deepEqual(boundInventory(),before,'source drift during proof');
 const accepted={passed:true,endToEndVerified:false,runId,inputArtifact:inputPath,inputSha256:digest(raw),reportArtifact:output,reportSha256:digest(reportBytes),sourceHashes:before,
  logs:['proof.log','inventory.log'].map(name=>({artifact:`${run}/${name}`,sha256:digest(fs.readFileSync(`${run}/${name}`))}))};
 const pending=`${run}/accepted.json`;fs.writeFileSync(pending,JSON.stringify(accepted,null,2)+'\n',{flag:'wx'});fs.renameSync(pending,receipt);
 console.log('Fresh native-handler gate passed: arithmetic prerequisite and three complete handler closures');
}
if(import.meta.main)await main();
