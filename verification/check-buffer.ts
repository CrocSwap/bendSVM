import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { model } from './model.ts';
import { prepareBend, BEND_COMMIT } from '../scripts/build.ts';

prepareBend();
fs.mkdirSync('build',{recursive:true});
const roots=['get_word','set_word','push_word','get_flag','set_flag','push_flag'];
async function prove(file:string,stem:string,expected:number) {
  fs.writeFileSync(stem+'.model.json',JSON.stringify(await model(file,roots))+'\n');
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/buffer.py',stem+'.model.json'],{encoding:'utf8'});
  assert.equal(result.status,expected,result.stderr||result.stdout);
  const report=JSON.parse(result.stdout);
  assert(report.claims.every((c:any)=>c.result==='unsat'||c.result==='sat'));
  if(expected===1)assert(report.claims.some((c:any)=>c.result==='sat'));
  return report;
}
const positive=await prove('tests/buffer.bend','build/buffer-refinement',0);
const source=fs.readFileSync('sdk/buffer.bend','utf8');
const fixture=fs.readFileSync('tests/buffer.bend','utf8');
const mutations=[];
for(const [name,before,after] of [
  ['accept full push','U32.is_lt(length, capacity)','U32.is_ge(capacity, length)'],
  ['accept index at length','U32.is_lt(index, length)','U32.is_ge(length, index)'],
  ['corrupt other element','Pair{value, right}','Pair{value, value}'],
  ['fail to increase length','U32.add(length, 1)','length'],
]) {
  const dir=fs.mkdtempSync('build/buffer-negative-');
  try {
    assert(source.includes(before));
    fs.writeFileSync(`${dir}/buffer.bend`,source.replaceAll(before,after));
    fs.writeFileSync(`${dir}/fixture.bend`,fixture.replace('../sdk/buffer.bend','./buffer.bend'));
    mutations.push({name,...await prove(`${dir}/fixture.bend`,`${dir}/result`,1)});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
const files=['sdk/buffer.bend','tests/buffer.bend','verification/model.ts','verification/prove.py',
  'verification/buffer.py','verification/check-buffer.ts','compiler/backend.ts','compiler/primitives.ts'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/buffer-refinement.json',JSON.stringify({bendCommit:BEND_COMMIT,positive,mutations,hashes},null,2)+'\n');
console.log('Bounded vector refinement: seven universal claims passed; four source mutations rejected');
