import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {validateReport,acceptChild,digest} from '../verification/check-tagged-sum-routing.ts';

const root=`build/tagged-sum-routing-tests/${randomUUID()}`;
fs.mkdirSync(root,{recursive:true});
const receipt='build/tagged-sum-routing-refinement.json';
const driver='verification/check-tagged-sum-routing.ts';
function run(env:NodeJS.ProcessEnv=process.env) {
  return spawnSync(process.execPath,[driver],{env,encoding:'utf8',timeout:240_000});
}
const first=run(); assert.equal(first.status,0,first.stderr);
const accepted=fs.readFileSync(receipt);
const report=JSON.parse(accepted.toString());
const bytes=fs.readFileSync(report.inputArtifact), input=JSON.parse(bytes.toString());
validateReport(report,input,bytes);
const rejected:string[]=[];
function reject(name:string,mutate:(r:any)=>void) {
  const candidate=structuredClone(report); mutate(candidate);
  assert.throws(()=>validateReport(candidate,input,bytes),undefined,name); rejected.push(name);
}
reject('false pass flag',r=>r.passed=false);
reject('stale run',r=>r.runId='old');
reject('wrong solver',r=>r.z3='other');
reject('wrong checker',r=>r.checkerSha256='0'.repeat(64));
reject('wrong source',r=>delete r.sourceHashes['compiler/backend.ts']);
reject('wrong input',r=>r.inputSha256='0'.repeat(64));
reject('missing proof',r=>r.proofs.pop());
reject('duplicate proof',r=>r.proofs[1]=r.proofs[0]);
reject('UNKNOWN proof',r=>r.proofs[0].result='UNKNOWN');
reject('SAT proof',r=>r.proofs[0].result='SAT');
reject('wrong instance count',r=>r.productionInstances++);
reject('wrong unique count',r=>r.uniqueOperations++);
reject('wrong kind counts',r=>r.counts.case++);
reject('missing mutation',r=>r.semanticMutations.pop());
reject('ineffective mutation',r=>r.semanticMutations[0].result='UNSAT');
reject('missing witness',r=>delete r.semanticMutations[0].witness);
reject('missing declaration check',r=>r.layoutChecks.pop());
reject('wrong declaration result',r=>r.layoutChecks[0].result='UNSAT');
reject('wrong declaration C hash',r=>r.layoutChecks[0].cSha256='0'.repeat(64));
reject('missing renderer record',r=>r.renderingChecks.pop());
reject('wrong renderer hash',r=>r.renderingChecks[0].renderingSha256='0'.repeat(64));
reject('wrong renderer result',r=>r.renderingChecks[0].result='UNSAT');
reject('missing maker proof',r=>r.constructorCProofs.pop());
reject('wrong C hash',r=>r.constructorCProofs[0].cSha256='0'.repeat(64));
reject('SAT maker proof',r=>r.constructorCProofs[0].result='SAT');
reject('missing C mutation',r=>r.constructorCMutations.pop());
reject('ineffective C mutation',r=>r.constructorCMutations[0].result='UNSAT');
reject('missing C grammar refusal',r=>r.constructorCGrammarRefusals.pop());

// Exercise the real driver: old success is moved away before even a failed
// checker starts. Malicious children here model process/report faults, not an
// attacker with write access to both verifier and sources.
const failures:string[]=[];
for(const [name,body] of [
  ['nonzero','raise SystemExit(29)'],
  ['zero without output','pass'],
  ['malformed report',"pathlib.Path(sys.argv[-1]).write_text('{')"],
  ['stale report',`pathlib.Path(sys.argv[-1]).write_bytes(pathlib.Path(${JSON.stringify(root+'/old.json')}).read_bytes())`],
  ['published then nonzero',`pathlib.Path(sys.argv[-1]).write_bytes(pathlib.Path(${JSON.stringify(root+'/old.json')}).read_bytes()); raise SystemExit(29)`],
] as const) {
  fs.writeFileSync(`${root}/old.json`,accepted);
  fs.writeFileSync(receipt,accepted);
  const before=new Set(fs.readdirSync('build/tagged-sum-routing'));
  const fake=`${root}/fake-python`;
  fs.writeFileSync(fake,'#!/usr/bin/env python3\nimport pathlib, sys\n'+body+'\n',{mode:0o755});
  const result=run({...process.env,PYTHON:fs.realpathSync(fake)});
  assert.notEqual(result.status,0,name);
  assert.equal(fs.existsSync(receipt),false,name+' left canonical success');
  const added=fs.readdirSync('build/tagged-sum-routing').filter(x=>!before.has(x));
  assert.equal(added.length,1);
  assert.deepEqual(fs.readFileSync(`build/tagged-sum-routing/${added[0]}/previous.json`),accepted);
  failures.push(name);
}
// A failure before the checker starts must also retire the old success.
fs.writeFileSync(receipt,accepted);
const runDirectory='build/tagged-sum-routing', savedDirectory=`${root}/saved-runs`;
const archivesBefore=new Set(fs.readdirSync('build'));
fs.renameSync(runDirectory,savedDirectory);
fs.writeFileSync(runDirectory,'intentional ENOTDIR probe\n');
try {
  const result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/ENOTDIR/);
  assert.equal(fs.existsSync(receipt),false,'mkdir failure left canonical success');
  const archives=fs.readdirSync('build').filter(name=>!archivesBefore.has(name) &&
    name.startsWith('tagged-sum-routing-refinement.json.') && name.endsWith('.previous'));
  assert.equal(archives.length,1);
  assert.deepEqual(fs.readFileSync(`build/${archives[0]}`),accepted,'mkdir failure lost prior evidence');
} finally {
  fs.rmSync(runDirectory);fs.renameSync(savedDirectory,runDirectory);
}
failures.push('run-directory failure preserves prior bytes outside canonical path');
// Actual timed-out child reaches the same process-status acceptance function.
const timed=spawnSync(process.env.PYTHON??'python3',['-c','import time; time.sleep(5)'],
  {encoding:'utf8',timeout:20});
assert.throws(()=>acceptChild(timed,`${root}/old.json`),/ETIMEDOUT/);
failures.push('timeout with success-looking file');
// Force UNKNOWN at the solver boundary of the actual Python checker.
const unknown=`import sys, importlib.util\nsys.path.insert(0,'verification')\nspec=importlib.util.spec_from_file_location('routing','verification/tagged_sum_routing.py')\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nclass Unknown:\n def set(self,**kw): pass\n def add(self,*args): pass\n def check(self): return m.z3.unknown\n def reason_unknown(self): return 'forced negative control'\nm.z3.Solver=Unknown\nsys.argv=['checker',${JSON.stringify(report.inputArtifact)},${JSON.stringify(root+'/unknown.json')}]\nm.main()\n`;
const probe=spawnSync(process.env.PYTHON??'python3',['-B','-c',unknown],{encoding:'utf8',timeout:10000});
assert.notEqual(probe.status,0);assert.match(probe.stderr,/UNKNOWN is not a proof/);
assert.equal(fs.existsSync(`${root}/unknown.json`),false);failures.push('UNKNOWN solver');
const inputFailures:string[]=[];
for(const [name,mutate,reason] of [
  ['empty operations',(d:any)=>d.operations=[],/empty operations/],
  ['source drift',(d:any)=>d.sourceHashes['compiler/backend.ts']='0'.repeat(64),/source drift/],
  ['unknown IR shape',(d:any)=>d.operations[0].ir.extra=true,/unsupported node shape/],
  ['C artifact drift',(d:any)=>d.artifacts[0].c+='\n',/artifact hash mismatch/],
  ['no C artifacts',(d:any)=>d.artifacts=[],/empty artifact inventory/],
  ['preprocessor reinterpretation',(d:any)=>{
    const a=d.artifacts[0];a.c=a.c.replace('#pragma once','#pragma once\n#define tag other');a.cSha256=digest(a.c);
  },/unsupported preprocessing/],
  ['commented maker text',(d:any)=>{
    const a=d.artifacts[0];a.c=a.c.replace('static inline','/* fake */ static inline');a.cSha256=digest(a.c);
  },/unsupported C lexical form/],
  ['missing rendering',(d:any)=>d.artifacts[0].renderings.pop(),/actual branch block inventory|actual constructor call inventory|operation offset|uncovered production/],
  ['unknown rendering owner',(d:any)=>d.artifacts[0].renderings[0].functionName='not_a_function',/unknown rendering function/],
  ['wrong rendering owner',(d:any)=>d.artifacts[0].renderings[0].functionName='bend_identity',/inventory/],
  ['digraph directive',(d:any)=>{
    const a=d.artifacts[0];a.c=a.c.replace('#pragma once','#pragma once\n%:define if(x) if(1)');a.cSha256=digest(a.c);
  },/unsupported C digraph/],
  ['narrowed tag',(d:any)=>{
    const a=d.artifacts[0];a.c=a.c.replace('bend_u32 tag;','unsigned char tag;');a.cSha256=digest(a.c);
  },/declaration differs from schema/],
  ['duplicate call',(d:any)=>{
    const a=d.artifacts[1];a.c=a.c.replace('return bend_Present_3c_U32_3e__make(a0);',
      '(void)bend_Present_3c_U32_3e__make(a0); return bend_Present_3c_U32_3e__make(a0);');a.cSha256=digest(a.c);
  },/constructor call inventory/],
  ['wrong rendering index',(d:any)=>d.artifacts[0].renderings[0].operation=999,/incomplete rendering inventory/],
  ['dropped fallback expression',(d:any)=>d.artifacts[0].renderings.find((r:any)=>r.kind==='case').miss.pop(),/miss expressions differ/],
  ['altered actual branch',(d:any)=>{
    const a=d.artifacts[0];a.c=a.c.replace('if ((a0).tag == 0u)', 'if ((a0).tag != 0u)');a.cSha256=digest(a.c);
  },/actual branch block inventory/],
  ['wrong actual maker',(d:any)=>{
    const a=d.artifacts[0];a.c=a.c.replace('.tag = 0', '.tag = 1');a.cSha256=digest(a.c);
  },/maker counterexample/],
] as const) {
  const candidate=structuredClone(input);mutate(candidate);
  const file=`${root}/invalid-input.json`, out=`${root}/invalid-output.json`;
  fs.writeFileSync(file,JSON.stringify(candidate));
  const child=spawnSync(process.env.PYTHON??'python3',[
    '-B','verification/tagged_sum_routing.py',file,out],{encoding:'utf8',timeout:10000});
  assert.notEqual(child.status,0,name);assert.match(child.stderr,reason);
  assert.equal(fs.existsSync(out),false); inputFailures.push(name);
}
const final=run();assert.equal(final.status,0,final.stderr);
fs.writeFileSync(`${root}/report.json`,JSON.stringify({passed:true,receiptNegatives:rejected,
  childFailures:failures,inputFailures,acceptedSha256:digest(fs.readFileSync(receipt))},null,2)+'\n');
console.log(`Tagged-sum receipt: ${rejected.length} report refusals, ${failures.length} child failure controls, ${inputFailures.length} input refusals; fresh gate passed`);
