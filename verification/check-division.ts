import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { prepareBend, BEND_COMMIT } from '../scripts/build.ts';

// Retire prior success before toolchain setup or any proof child can fail.
const reportPath='build/division-refinement.json';
const attempt=`build/division-refinement-attempts/${crypto.randomUUID()}`;
fs.mkdirSync(attempt,{recursive:true});
if(fs.existsSync(reportPath))fs.renameSync(reportPath,`${attempt}/previous.json`);
prepareBend();
const {model}=await import('./model.ts');
const B=await import('../.deps/bend/bend2/bend.ts');
const {checkedBook}=await import('../compiler/backend.ts');
const roots=['div_step','div2','div4','div8','div16','div32','div64','divmod','div','mod'];
fs.mkdirSync('build',{recursive:true});
async function run(source:string,stem:string,expected:number) {
  fs.writeFileSync(stem+'.model.json',JSON.stringify(await model(source,roots))+'\n');
  const output=spawnSync(process.env.PYTHON??'python3',['-B','verification/division_step.py',stem+'.model.json'],{encoding:'utf8'});
  const evidence=`${attempt}/${crypto.randomUUID()}`;
  fs.writeFileSync(evidence+'.log',(output.stdout??'')+(output.stderr??'')+(output.error?String(output.error):''));
  fs.writeFileSync(evidence+'.json',JSON.stringify({source,model:stem+'.model.json',
    modelSha256:crypto.createHash('sha256').update(fs.readFileSync(stem+'.model.json')).digest('hex'),
    expectedExitCode:expected,exitCode:output.status??null,signal:output.signal,error:output.error?String(output.error):null},null,2)+'\n');
  assert.ifError(output.error);assert.equal(output.signal,null,'division proof child signal');
  assert.equal(output.status,expected,output.stderr||output.stdout);
  const report=JSON.parse(output.stdout);
  assert.equal(report.step.result,expected===0?'unsat':'sat','Timeouts do not satisfy either check');
  if(expected!==0) {
    const {q,r,d}=Object.fromEntries(Object.entries(report.step.counterexample).map(([k,v])=>[k,BigInt(v as string)]));
    const word=(v:bigint)=>B.Ctr('U64',[B.term_higher(B.u32_to_term(Number(v&0xffffffffn))),B.term_higher(B.u32_to_term(Number(v>>32n)))]);
    const book=await checkedBook(source);
    const result=B.term_snf(book,B.App(B.Ref('div_step'),B.Ctr('DivState',[word(q),word(r),word(d)])));
    assert.equal(result.$,'Ctr');if(result.$!=='Ctr') throw new Error('Expected state');
    const unpack=(term:B.HTerm)=>{assert.equal(term.$,'Ctr');if(term.$!=='Ctr') throw new Error('Expected word');
      return BigInt(B.u32_from_term(term.x[0])!)+(BigInt(B.u32_from_term(term.x[1])!)<<32n);};
    const n=2n*r+(q>>63n),take=n>=d;
    const mathematical=[((q<<1n)|(take?1n:0n))&((1n<<64n)-1n),take?n-d:n,d].map(String);
    const bend=result.x.map(unpack).map(String);
    assert.notDeepEqual(bend,mathematical,'Counterexample must replay in Bend');
    report.step.replay={bend,mathematical};
  }
  return report;
}
const positive=await run('sdk/math.bend','build/division-refinement',0);
const source=fs.readFileSync('sdk/math.bend','utf8');
assert.equal(positive.induction.length,68);
assert.ok(positive.induction.every((c:any)=>c.result==='unsat'));
assert.equal(positive.fastPaths.length,33);
assert.ok(positive.fastPaths.every((c:any)=>c.result==='unsat'));
assert.deepEqual(positive.wrappers.map((c:any)=>[c.claim,c.result]),[['divmod','unsat'],['div','unsat'],['mod','unsat']]);
const mutations=[];
for(const [name,before,after] of [
  ['discard remainder carry','Bool.or(Bool.not(U32.is_zero(top(r))), Bool.not(less(next, d)))','Bool.not(less(next, d))'],
  ['discard quotient bit','div_reduce(reduce, shift_in(q, 0), next, d)','div_reduce(reduce, q, next, d)'],
]) {
  const dir=fs.mkdtempSync('build/division-negative-');
  try {
    assert.ok(source.includes(before));fs.writeFileSync(`${dir}/math.bend`,source.replace(before,after));
    mutations.push({name,...await run(`${dir}/math.bend`,`${dir}/result`,1)});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
// A dropped step is a composition failure even when the step itself is correct.
const dir=fs.mkdtempSync('build/division-composition-negative-');
try {
  fs.writeFileSync(`${dir}/math.bend`,source.replace('div32(div32(s))','div32(s)'));
  fs.writeFileSync(`${dir}/model.json`,JSON.stringify(await model(`${dir}/math.bend`,roots)));
  const output=spawnSync(process.env.PYTHON??'python3',['-B','verification/division_step.py',`${dir}/model.json`],{encoding:'utf8'});
  assert.notEqual(output.status,0);assert.match(output.stderr,/div64 must apply div32 twice/);
} finally {fs.rmSync(dir,{recursive:true,force:true});}
const wrapperMutations=[];
for(const [name,before,after] of [
  ['swap quotient and remainder','DivOk{Division{q, r}}','DivOk{Division{r, q}}'],
  ['wrong zero-divisor error','DivErr{3}','DivErr{0}'],
  ['wrong less-than direct exit','DivOk{Division{zero(), a}}','DivOk{Division{a, zero()}}'],
  ['wrong high-divisor quotient state','DivState{U64{0, lo}, U64{hi, 0}, b}','DivState{U64{lo, 0}, U64{hi, 0}, b}'],
  ['inclusive 32-step guard','U32.is_lt(ah, bl)','Bool.not(U32.is_lt(bl, ah))'],
]) {
  const dir=fs.mkdtempSync('build/division-wrapper-negative-');
  try {
    assert.ok(source.includes(before));fs.writeFileSync(`${dir}/math.bend`,source.replace(before,after));
    fs.writeFileSync(`${dir}/model.json`,JSON.stringify(await model(`${dir}/math.bend`,roots)));
    const output=spawnSync(process.env.PYTHON??'python3',['-B','verification/division_step.py',`${dir}/model.json`],{encoding:'utf8'});
    assert.equal(output.status,1,output.stderr||output.stdout);
    assert.ok(output.stdout.trim(), output.stderr || 'division negative check produced no report');
    const report=JSON.parse(output.stdout);
    assert.equal(report.step.result,'unsat');assert.ok(report.induction.every((c:any)=>c.result==='unsat'));
    assert.ok(report.fastPaths.every((c:any)=>c.result==='unsat'));
    assert.ok(report.wrappers.some((c:any)=>c.result==='sat'));
    assert.ok(report.wrappers.every((c:any)=>['sat','unsat'].includes(c.result)),'No timeout is acceptable');
    const book=await checkedBook(`${dir}/math.bend`);
    const word=(v:bigint)=>B.Ctr('U64',[B.term_higher(B.u32_to_term(Number(v&0xffffffffn))),B.term_higher(B.u32_to_term(Number(v>>32n)))]);
    const unpack=(t:B.HTerm):string=>{assert.equal(t.$,'Ctr');if(t.$!=='Ctr') throw new Error('Expected word');
      return (BigInt(B.u32_from_term(t.x[0])!)+(BigInt(B.u32_from_term(t.x[1])!)<<32n)).toString();};
    for(const claim of report.wrappers.filter((c:any)=>c.result==='sat')) {
      const a=BigInt(claim.counterexample.a),b=BigInt(claim.counterexample.b);
      const result=B.term_snf(book,B.App(B.App(B.Ref(claim.claim),word(a)),word(b)));
      assert.equal(result.$,'Ctr');if(result.$!=='Ctr') throw new Error('Expected result');
      let actual:unknown;
      if(['DivErr','Err'].includes(result.k)) actual={error:B.u32_from_term(result.x[0])};
      else if(claim.claim==='divmod') {
        const pair=result.x[0];assert.equal(pair.$,'Ctr');if(pair.$!=='Ctr') throw new Error('Expected division');
        actual={quotient:unpack(pair.x[0]),remainder:unpack(pair.x[1])};
      } else actual={value:unpack(result.x[0])};
      const mathematical=b===0n?{error:3}:claim.claim==='divmod'?{quotient:(a/b).toString(),remainder:(a%b).toString()}:
        {value:(claim.claim==='div'?a/b:a%b).toString()};
      assert.notDeepEqual(actual,mathematical,'Wrapper counterexample must replay in Bend');
      claim.replay={bend:actual,mathematical};
    }
    wrapperMutations.push({name,...report});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
const files=['sdk/math.bend','verification/model.ts','verification/prove.py','verification/division_step.py','verification/division_loop.py','verification/check-division.ts'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync(reportPath,JSON.stringify({bendCommit:BEND_COMMIT,positive,mutations,wrapperMutations,missing_step_rejected:true,hashes},null,2)+'\n');
console.log('Universal division refinement passed: step, composition, 68 induction and 33 fast-path obligations, public wrappers; seven semantic mutations replayed; missing step rejected');
