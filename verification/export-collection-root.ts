import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Backend,checkedProgram} from '../compiler/backend.ts';
import {model} from './model.ts';
import {inventory,digest,syntaxCheck} from './check-acyclic-lowering.ts';
export function collectionInventory(){
 return {...inventory(),...Object.fromEntries(fs.readdirSync('runtime').filter(n=>/\.(h|c|ld)$/.test(n)).map(n=>[`runtime/${n}`,digest(fs.readFileSync(`runtime/${n}`))]))};
}
export async function main(run=`build/collection-root/runs/${randomUUID()}`){
 fs.mkdirSync(run,{recursive:true});
 const before=collectionInventory();
 const child=spawnSync(process.execPath,['verification/check-collection-composition.ts'],{encoding:'utf8',timeout:1200000,maxBuffer:32*1024*1024});
 fs.writeFileSync(`${run}/composition.log`,(child.stdout??'')+(child.stderr??''));assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,`${run}/composition.log`);
 const compositionPath='build/collection-composition-refinement.json',compositionRaw=fs.readFileSync(compositionPath),composition=JSON.parse(compositionRaw.toString());assert.equal(composition.passed,true);
 const archivedComposition=`${run}/composition.json`;fs.writeFileSync(archivedComposition,compositionRaw,{flag:'wx'});
 const bundlePath=`build/collection-composition-runs/${composition.compositionRunId}/composition-input.json`,bundle=JSON.parse(fs.readFileSync(bundlePath,'utf8'));
 const prerequisites:Record<string,{artifact:string,sha256:string}>={composition:{artifact:path.resolve(archivedComposition),sha256:digest(compositionRaw)},bundle:{artifact:path.resolve(bundlePath),sha256:digest(fs.readFileSync(bundlePath))}};
 for(const kind of ['runtime','lifecycle','caller']){
  const artifact=bundle[`${kind}ReceiptPath`],raw=fs.readFileSync(artifact),receipt=JSON.parse(raw.toString());
  assert.equal(digest(raw),composition.helperReceiptByteHashes[kind]);assert.equal(receipt.passed,true);assert.equal(receipt.compositionRunId,composition.compositionRunId);
  prerequisites[kind]={artifact,sha256:digest(raw)};
 }
 const caller=JSON.parse(fs.readFileSync(prerequisites.caller.artifact,'utf8'));
 const file='tests/collection-store.bend',roots=['process','select'],checked=await checkedProgram(file),source=await model(file,roots),emitted=new Backend(checked.book).emit(roots);
 const sourceHashes=Object.fromEntries(checked.files.map(p=>[p,digest(fs.readFileSync(p))]));
 assert.equal(fs.readFileSync(caller.artifactPaths['collection-store.h'],'utf8'),emitted.c,'shared C header');
 assert.deepEqual(JSON.parse(fs.readFileSync(caller.artifactPaths['collection-store.schema.json'],'utf8')),emitted.schema);
 const program={source,defaultProductionCMatches:true,artifact:{fixture:file,c:emitted.c,cSha256:digest(emitted.c),schema:emitted.schema},sourceHashes};
 const cSyntax=syntaxCheck([program],run),artifactHashes:Record<string,string>={};
 for(const artifact of new Set<string>([...Object.values(caller.artifactPaths),...Object.values(caller.includePaths)] as string[]))artifactHashes[artifact]=digest(fs.readFileSync(artifact));
 assert.deepEqual(collectionInventory(),before,'source drift');
 const input={version:1,runId:path.basename(run),program,caller,composition,prerequisites,artifactHashes,sourceHashes:before,cSyntax};
 fs.writeFileSync(`${run}/input.json`,JSON.stringify(input,null,2)+'\n',{flag:'wx'});
 console.log(`Fresh collection root input: ${run}/input.json`);return `${run}/input.json`;
}
if(import.meta.main)await main();
