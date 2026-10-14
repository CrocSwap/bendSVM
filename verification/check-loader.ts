import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {inventory,digest,acceptProcess} from './check-acyclic-lowering.ts';
export const loaderInventory=()=>({...inventory(),'runtime/solana_min.h':digest(fs.readFileSync('runtime/solana_min.h'))});
export async function main(base='build/loader'){
 const id=randomUUID(),run=`${base}/runs/${id}`,receipt=`${base}/fresh-receipt.json`;
 fs.mkdirSync(run,{recursive:true});if(fs.existsSync(receipt))fs.renameSync(receipt,`${run}/previous.json`);
 const before=loaderInventory(),header=`${run}/solana_min.h`;fs.copyFileSync('runtime/solana_min.h',header);
 const python=process.env.PYTHON??'python3',frontend=process.env.CC??'clang';
 const located=spawnSync('/usr/bin/which',[frontend],{encoding:'utf8',timeout:10000});assert.ifError(located.error);assert.equal(located.status,0,'missing C frontend');const compiler=located.stdout.trim();assert.ok(compiler);
 const unit=`${run}/syntax.c`;fs.writeFileSync(unit,'#include "solana_min.h"\n_Static_assert(sizeof(void *) == 8, "64-bit native address profile");\n',{flag:'wx'});
 const syntax=spawnSync(compiler,['-std=c11','-fsyntax-only',unit],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024}),log=`${run}/syntax.log`;
 fs.writeFileSync(log,(syntax.stdout??'')+(syntax.stderr??''));assert.ifError(syntax.error);assert.equal(syntax.signal,null);assert.equal(syntax.status,0,'C syntax check failed');
 const input={version:1,runId:id,headerArtifact:header,headerSha256:digest(fs.readFileSync(header)),sourceHashes:before,
  cSyntax:{compiler,compilerSha256:digest(fs.readFileSync(compiler)),exitCode:0,log,logSha256:digest(fs.readFileSync(log)),unit,unitSha256:digest(fs.readFileSync(unit))}};
 const inputPath=`${run}/input.json`,output=`${run}/report.json`;fs.writeFileSync(inputPath,JSON.stringify(input,null,2)+'\n',{flag:'wx'});const raw=fs.readFileSync(inputPath);
 const child=spawnSync(python,['-B','verification/loader_model.py',inputPath,output],{encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 fs.writeFileSync(`${run}/proof.log`,(child.stdout??'')+(child.stderr??''));const report=acceptProcess(child,output);
 assert.equal(report.passed,true);assert.equal(report.endToEndVerified,false);assert.equal(report.runId,id);assert.equal(report.inputSha256,digest(raw));assert.deepEqual(report.sourceHashes,before);
 const checked=spawnSync(python,['-B','verification/loader_report.py',inputPath,output],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
 fs.writeFileSync(`${run}/inventory.log`,(checked.stdout??'')+(checked.stderr??''));assert.ifError(checked.error);assert.equal(checked.signal,null);assert.equal(checked.status,0,'loader report validation failed');
 assert.deepEqual(loaderInventory(),before);assert.deepEqual(fs.readFileSync(inputPath),raw);assert.equal(digest(fs.readFileSync(header)),input.headerSha256);
 for(const [p,h] of [[compiler,input.cSyntax.compilerSha256],[unit,input.cSyntax.unitSha256],[log,input.cSyntax.logSha256]])assert.equal(digest(fs.readFileSync(p)),h);
 const accepted={passed:true,endToEndVerified:false,runId:id,inputArtifact:inputPath,inputSha256:digest(raw),reportArtifact:output,reportSha256:digest(fs.readFileSync(output)),sourceHashes:before,
  logs:['proof.log','inventory.log','syntax.log'].map(n=>({artifact:`${run}/${n}`,sha256:digest(fs.readFileSync(`${run}/${n}`))}))};
 const pending=`${run}/accepted.json`;fs.writeFileSync(pending,JSON.stringify(accepted,null,2)+'\n',{flag:'wx'});fs.renameSync(pending,receipt);
 console.log('Fresh conditional account decoder proof accepted');return accepted;
}
if(import.meta.main)await main();
