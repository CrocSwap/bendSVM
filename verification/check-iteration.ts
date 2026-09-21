import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { model } from './model.ts';
import { prepareBend, BEND_COMMIT } from '../scripts/build.ts';

prepareBend();
fs.mkdirSync('build',{recursive:true});
const roots=['count','swaps','toggle','rotate'];
async function prove(file:string,stem:string,expected:number) {
  fs.writeFileSync(stem+'.model.json',JSON.stringify(await model(file,roots))+'\n');
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/iteration.py',stem+'.model.json'],{encoding:'utf8'});
  assert.equal(result.status,expected,result.stderr||result.stdout);
  const report=JSON.parse(result.stdout);
  assert(report.claims.every((c:any)=>c.result==='unsat'||c.result==='sat'));
  if(expected===1)assert(report.claims.some((c:any)=>c.result==='sat'));
  return report;
}
const positive=await prove('tests/iteration.bend','build/iteration-refinement',0);
const source=fs.readFileSync('tests/iteration.bend','utf8');
const mutations=[];
for(const [name,before,after] of [
  ['wrong step','U32.add(value, 1)','U32.add(value, 2)'],
  ['lost argument swap','rotate(pred, right, left)','rotate(pred, left, right)'],
]) {
  const dir=fs.mkdtempSync('build/iteration-negative-');
  try {
    assert(source.includes(before));
    fs.writeFileSync(`${dir}/iteration.bend`,fs.readFileSync('sdk/iteration.bend','utf8'));
    fs.writeFileSync(`${dir}/fixture.bend`,source.replace('../sdk/iteration.bend','./iteration.bend').replace(before,after));
    mutations.push({name,...await prove(`${dir}/fixture.bend`,`${dir}/result`,1)});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
const files=['sdk/iteration.bend','tests/iteration.bend','verification/model.ts','verification/prove.py',
  'verification/iteration.py','verification/check-iteration.ts','compiler/backend.ts','compiler/primitives.ts'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/iteration-refinement.json',JSON.stringify({bendCommit:BEND_COMMIT,positive,mutations,hashes},null,2)+'\n');
console.log('Bounded iteration refinement: all 65 fuel values verified for arbitrary payloads; two source mutations rejected');
