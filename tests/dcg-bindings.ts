import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Backend, checkedProgram} from '../compiler/backend.ts';
import {writeArtifacts} from '../compiler/artifacts.ts';
import {BEND_COMMIT, prepareBend, run} from '../scripts/build.ts';
import {wireCodec} from '../sdk/wire.ts';
import {nativeSource} from './dcg-bindings/native.ts';
import {casesFor as completionCases} from './dcg-bindings/fact-bindings.ts';
import {casesFor as winnerCases} from './dcg-bindings/winner-cache.ts';
import {casesFor as resultCases} from './dcg-bindings/result-binding.ts';
function digest(file: string): string {
 return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function filesIn(dir: string): string[] {
 return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{
  const file=path.join(dir,e.name);
  return e.isDirectory()?filesIn(file):e.isFile()?[file]:[];
 });
}
function sourceSnapshot() {
 const files=[...filesIn('compiler'),...filesIn('runtime'),...filesIn('sdk'),
  ...filesIn('tests/dcg-bindings'),...filesIn('tests/dcg-facts').filter(f=>f.endsWith('.bend')),
  'tests/dcg-bindings.ts','scripts/build.ts','package.json',
  ...filesIn('.deps/bend/bend2').filter(f=>f.endsWith('.ts')||f.endsWith('.bend'))];
 return Object.fromEntries(files.sort().map(file=>[file,digest(file)]));
}
prepareBend();
const bendBefore={commit:run('git',['-C','.deps/bend','rev-parse','HEAD'],true),clean:run('git',['-C','.deps/bend','status','--porcelain'],true)==='',expected:BEND_COMMIT};
const sourceBefore=sourceSnapshot();
const roots=['prior_bound131','ledger_bound172','winner_bound172','winner_cache_bound172','winner_recipient_bound172','result_row1_bound172'];
const dir=path.resolve('build/dcg-bindings',crypto.randomUUID());
const stem=path.join(dir,'bindings');
const checked=await checkedProgram('tests/dcg-facts/fact-bindings.bend');
const emitted=new Backend(checked.book).emit(roots);
writeArtifacts(stem,emitted);
const schema=emitted.schema,codec=wireCodec(schema);
fs.writeFileSync(stem+'.native.c',nativeSource(stem));
const cc=spawnSync(process.env.CC??'clang',['-std=c11','-O1','-g','-fsanitize=address,undefined','-fno-sanitize-recover=all',stem+'.native.c','-o',stem+'.native'],{encoding:'utf8'});
assert.ifError(cc.error);assert.equal(cc.status,0,cc.stderr);
const cases=[...completionCases(schema),...winnerCases(schema),...resultCases(schema)];
assert.equal(cases.length,169);
const results=[];
for(const c of cases) {
 const request=codec.call(c.fn,[c.input]);
 const r=spawnSync(stem+'.native',[],{encoding:'utf8',input:`${request.length} 1024 ${[...request].join(' ')}\n`});
 assert.ifError(r.error);assert.equal(r.status,0,r.stderr);
 const bytes=r.stdout.trim().split(/\s+/).map(Number);assert.equal(bytes.shift(),1);
 const reply=codec.reply(c.fn,Uint8Array.from(bytes));
 const actual=typeof c.expected==='boolean'?reply:(reply as any).constructor;
 assert.equal(actual,c.expected,`${c.fn}: ${c.label}`);
 results.push({function:c.fn,label:c.label,actual});
}
const artifacts=Object.fromEntries(fs.readdirSync(dir).filter(name=>fs.statSync(path.join(dir,name)).isFile()).map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,name))).digest('hex')]));
prepareBend();
const sourceAfter=sourceSnapshot();
assert.deepEqual(sourceAfter,sourceBefore,'source changed during binding test');
fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify({bend:bendBefore,sourceHashes:sourceBefore,scope:'Finite emitted native C regressions under ASan/UBSan; no authentication, accumulator provenance, SBF execution or universal preservation claim.',artifacts,results},null,2)+'\n');
console.log(`PASS ${results.length} DCG binding cases; ${dir}/report.json`);
