import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { model } from './model.ts';
import { prepareBend, BEND_COMMIT } from '../scripts/build.ts';

prepareBend();
fs.mkdirSync('build',{recursive:true});
const roots=['read_range','reserve_range','get_word','get_flag','set_word','set_flag','push_word','push_flag'];
async function prove(file:string,stem:string,expected:number) {
  fs.writeFileSync(stem+'.model.json',JSON.stringify(await model(file,roots))+'\n');
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/collection.py',stem+'.model.json'],{encoding:'utf8'});
  assert.equal(result.status,expected,result.stderr||result.stdout);
  const report=JSON.parse(result.stdout);
  assert.equal(report.claims.length,9);
  assert(report.claims.every((c:any)=>c.result==='unsat'||c.result==='sat'));
  if(expected===1)assert(report.claims.some((c:any)=>c.result==='sat'));
  return report;
}
const positive=await prove('tests/collection.bend','build/collection-refinement',0);
const source=fs.readFileSync('sdk/collection.bend','utf8');
const fixture=fs.readFileSync('tests/collection.bend','utf8');
const mutations=[];
for(const [name,before,after] of [
  ['wrapped range accepted','Bool.and(U32.is_ge(limit, start), U32.is_ge(U32.sub(limit, start), count))','U32.is_ge(U32.sub(limit, start), count)'],
  ['read inactive records','fits(start, count, length)','fits(start, count, capacity)'],
  ['reserve leaves holes','U32.is_ge(length, start)','True{}'],
  ['global index underflows','U32.is_ge(index, start)','True{}'],
  ['updated window loses origin','B.Valid{Window{start, value}}','B.Valid{Window{0, value}}'],
]) {
  const dir=fs.mkdtempSync('build/collection-negative-');
  try {
    assert(source.includes(before));
    fs.writeFileSync(`${dir}/collection.bend`,source.replaceAll(before,after)
      .replace('Metadata{+length, capacity}', 'Metadata{+length, +capacity}')
      .replace('./buffer.bend','../../sdk/buffer.bend')
      .replace('./context.bend','../../sdk/context.bend').replace('./math.bend','../../sdk/math.bend'));
    fs.writeFileSync(`${dir}/fixture.bend`,fixture.replace('../sdk/collection.bend','./collection.bend').replace('../sdk/buffer.bend','../../sdk/buffer.bend'));
    mutations.push({name,...await prove(`${dir}/fixture.bend`,`${dir}/result`,1)});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
const files=['sdk/collection.bend','sdk/buffer.bend','sdk/context.bend','sdk/math.bend','tests/collection.bend','verification/model.ts','verification/prove.py',
  'verification/collection.py','verification/check-collection.ts','compiler/backend.ts','compiler/primitives.ts'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/collection-refinement.json',JSON.stringify({bendCommit:BEND_COMMIT,positive,mutations,hashes},null,2)+'\n');
console.log('Collection range/read/update/append refinement: nine universal claims passed; five source mutations rejected');
