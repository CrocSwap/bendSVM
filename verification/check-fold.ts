import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { model } from './model.ts';
import { prepareBend, BEND_COMMIT } from '../scripts/build.ts';

prepareBend();
fs.mkdirSync('build',{recursive:true});
const roots=['sum','ordered','conjunction'];
async function prove(file:string,stem:string,expected:number) {
  fs.writeFileSync(stem+'.model.json',JSON.stringify(await model(file,roots))+'\n');
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/fold.py',stem+'.model.json',...(expected===1?['counterexample']:[])],{encoding:'utf8'});
  assert.equal(result.status,expected,result.stderr||result.stdout);
  const report=JSON.parse(result.stdout);
  const cases=report.claims.flatMap((c:any)=>c.cases);
  assert(cases.every((c:any)=>c.result==='unsat'||c.result==='sat'),'Timeout/unknown is not proof evidence');
  if(expected===1)assert(cases.some((c:any)=>c.result==='sat'));
  return report;
}
const positive=await prove('tests/fold.bend','build/fold-refinement',0);
const library=fs.readFileSync('sdk/fold.bend','utf8');
const fixture=fs.readFileSync('tests/fold.bend','utf8');
const mutations=[];
for(const [name,target,before,after] of [
  ['wrong traversal','library','read, vector, index)','read, vector, U32.sub(U32.sub(capacity, 1), index))'],
  ['missing length agreement','library','U32.is_eq(index, length)','True{}'],
  ['ignored overflow','fixture','U32.is_lt(sum, start)','False{}'],
]) {
  const dir=fs.mkdtempSync('build/fold-negative-');
  try {
    assert((target==='library'?library:fixture).includes(before));
    for(const file of ['buffer.bend','iteration.bend'])fs.copyFileSync(`sdk/${file}`,`${dir}/${file}`);
    fs.writeFileSync(`${dir}/fold.bend`,target==='library'?library.replace(before,after):library);
    fs.writeFileSync(`${dir}/fixture.bend`,(target==='fixture'?fixture.replace(before,after):fixture).replaceAll('../sdk/','./'));
    mutations.push({name,...await prove(`${dir}/fixture.bend`,`${dir}/result`,1)});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
const files=['sdk/fold.bend','sdk/buffer.bend','sdk/iteration.bend','tests/fold.bend','verification/model.ts',
  'verification/prove.py','verification/fold.py','verification/check-fold.ts','compiler/backend.ts','compiler/primitives.ts'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/fold-refinement.json',JSON.stringify({bendCommit:BEND_COMMIT,positive,mutations,hashes},null,2)+'\n');
console.log('Fold refinement: sums, ordered reduction and conjunction verified for all 65 fuels and arbitrary payloads; three source mutations rejected');
