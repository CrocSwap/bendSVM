import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {prepareBend,BEND_COMMIT} from '../scripts/build.ts';

// Retire a prior receipt before prerequisites can fail. Failed attempts must
// never leave an earlier success at the canonical report path.
fs.mkdirSync('build',{recursive:true});
const reportPath='build/wide-refinement.json';
const attemptPath=`build/wide-refinement-attempts/${crypto.randomUUID()}`;
fs.mkdirSync(attemptPath,{recursive:true});
if(fs.existsSync(reportPath))fs.renameSync(reportPath,`${attemptPath}/previous.json`);
const files=['sdk/math.bend','sdk/wide.bend','verification/model.ts','verification/prove.py','verification/division_step.py','verification/division_loop.py','verification/multiplication.py','verification/wide.py','verification/wide_division.py','verification/small_division.py','verification/check-wide.ts','compiler/primitives.ts','compiler/backend.ts','scripts/build.ts'];
const inputHashes=()=>Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
const hashes=inputHashes();
fs.writeFileSync(`${attemptPath}/inputs.json`,JSON.stringify(hashes,null,2)+'\n');

prepareBend();
const {model}=await import('./model.ts');
const {checkedBook}=await import('../compiler/backend.ts');
const B=await import('../.deps/bend/bend2/bend.ts');
fs.mkdirSync('build',{recursive:true});
const roots=['add','product_parts','product','divide','mul_div','floor','ceil'];
const mathPath='build/wide-refinement.math.model.json';
fs.writeFileSync(mathPath,JSON.stringify(await model('sdk/math.bend',['mul32_parts','mul32','mul_parts','mul','div_step','div2','div4','div8','div16','div32','div64','divmod','div','mod']))+'\n');
async function run(source:string,stem:string,status:number) {
  fs.writeFileSync(stem+'.model.json',JSON.stringify(await model(source,roots))+'\n');
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/wide.py',mathPath,stem+'.model.json'],{encoding:'utf8'});
  assert.ifError(result.error);
  assert.equal(result.signal,null,'Wide proof child terminated by signal');
  assert.equal(result.status,status,result.stderr||result.stdout);
  const report=JSON.parse(result.stdout);
  assert.equal(report.multiplication.claims.length,14);
  assert.ok(report.multiplication.claims.every((c:any)=>c.result==='unsat'));
  assert.equal(report.loop.step.result,'unsat');
  assert.equal(report.loop.induction.length,68);
  assert.ok(report.loop.induction.every((c:any)=>c.result==='unsat'));
  assert.equal(report.fastPaths.length,33);
  assert.ok(report.fastPaths.every((c:any)=>c.result==='unsat'));
  assert.deepEqual(report.loop.wrappers.map((c:any)=>[c.claim,c.result]),['divmod','div','mod'].map(name=>[name,'unsat']));
  assert.equal(report.divisionBridge.length,9);
  assert.ok(report.divisionBridge.every((c:any)=>c.result==='unsat'));
  assert.ok(report.calleeBindings.includes('math.divmod') && report.calleeBindings.includes('math.div64'));
  assert.equal(report.smallDivision.length,15);
  assert.ok(report.smallDivision.every((c:any)=>['sat','unsat'].includes(c.result)),
    'Small-divisor timeout is not a positive or negative proof');
  assert.ok(report.claims.every((c:any)=>['sat','unsat'].includes(c.result)),'Timeout is not a pass');
  if(status===0) {
    assert.equal(report.claims.length,12);
    assert.equal(report.smallDivision.length,15);
    assert.ok(report.smallDivision.every((c:any)=>c.result==='unsat'));
    assert.deepEqual(report.claims.map((c:any)=>c.claim),[
      'wide-quotient-overflow-threshold','integer-floor-ceiling',
      'wide-divide-wrapper','wide-zero-precedence','wide-overflow-error',
      'wide-divisor-one','wide-native64-route','wide-small32-route','wide-div64-route',
      'mul-div-composition','floor-wrapper','ceil-wrapper']);
    assert.ok(report.claims.every((c:any)=>c.result==='unsat'));
  }
  return report;
}
const positive=await run('sdk/wide.bend','build/wide-refinement',0);
const math=fs.readFileSync('sdk/math.bend','utf8'),wide=fs.readFileSync('sdk/wide.bend','utf8');
const mask=(1n<<64n)-1n;
const u32=(n:bigint)=>B.term_higher(B.u32_to_term(Number(n)));
const word=(n:bigint)=>B.Ctr('math.U64',[u32(n&0xffffffffn),u32(n>>32n)]);
const wideWord=(n:bigint)=>B.Ctr('U128',[word(n&mask),word(n>>64n)]);
function unpack(t:any):string {
  assert.equal(t.$,'Ctr');assert.equal(t.k,'math.U64');
  return (BigInt(B.u32_from_term(t.x[0])!)+(BigInt(B.u32_from_term(t.x[1])!)<<32n)).toString();
}
const mutations=[];
// These witnesses are concrete, independent of the abstract q/r or product
// symbols in wrapper SAT models. Do not report them as solver-input replays.
for(const [name,before,after,claimName,root,inputs] of [
  ['small quotient limb order','Math.U64{ql, qh}','Math.U64{qh, ql}','small-checked-source-quotient-remainder','divide',[(1n<<65n)-1n,100n]],
  ['small first dividend limbs','Math.divmod(Math.U64{lh, hl}','Math.divmod(Math.U64{hl, lh}','small-native-call-0-arguments','divide',[(1n<<65n)-1n,100n]],
  ['small second dividend limbs','Math.divmod(Math.U64{low, rh}','Math.divmod(Math.U64{rh, low}','small-native-call-1-arguments','divide',[(1n<<65n)-1n,100n]],
  ['lost high dividend','Math.DivState{low, high, divisor}','Math.DivState{low, Math.zero(), divisor}','wide-divide-wrapper','divide',[(1n<<64n)+1n,(1n<<32n)+1n]],
  ['reversed overflow guard','Math.less(high, divisor)','Math.less(divisor, high)','wide-divide-wrapper','divide',[5n,2n]],
  ['wrong zero-divisor error','Math.DivErr{3}','Math.DivErr{0}','wide-divide-wrapper','divide',[5n,0n]],
  ['wrong composed divisor','divide(product(a, b), divisor)','divide(product(a, divisor), b)','mul-div-composition','mul_div',[6n,4n,3n]],
  ['floor returns remainder','Math.quotient(mul_div(a, b, divisor))','Math.remainder(mul_div(a, b, divisor))','floor-wrapper','floor',[6n,4n,4n]],
  ['reversed exact-rounding guard','round_up(Math.equal(r, Math.zero()), q)','round_up(Bool.not(Math.equal(r, Math.zero())), q)','ceil-wrapper','ceil',[1n,1n,1n]],
  ['ceiling drops increment','Math.add(quotient, Math.U64{1, 0})','Math.Ok{quotient}','ceil-wrapper','ceil',[1n,1n,2n]],
  ['native route with nonzero high','Math.equal(high, Math.zero())','Math.equal(high, Math.U64{1, 0})','wide-divide-wrapper','divide',[(1n<<64n)+1n,2n]],
  ['wrong native dividend','Math.divmod(low, divisor)','Math.divmod(high, divisor)','wide-divide-wrapper','divide',[7n,2n]],
  ['zeroed native divisor','Math.divmod(low, divisor)','Math.divmod(low, Math.zero())','wide-divide-wrapper','divide',[7n,2n]],
  ['swapped native operands','Math.divmod(low, divisor)','Math.divmod(divisor, low)','wide-divide-wrapper','divide',[7n,2n]],
  ['zero guard loses precedence','divide_guard(Math.equal(divisor, Math.zero()), value, divisor)','divide_guard(Math.equal(divisor, Math.U64{1, 0}), value, divisor)','wide-divide-wrapper','divide',[(1n<<64n)+1n,0n]],
] as const) {
  const dir=fs.mkdtempSync('build/wide-negative-');
  try {
    assert.equal(wide.split(before).length,2,'Mutation must have exactly one target');
    fs.writeFileSync(`${dir}/math.bend`,math);
    fs.writeFileSync(`${dir}/wide.bend`,wide.replace(before,after));
    const report=await run(`${dir}/wide.bend`,`${dir}/result`,1);
    assert.equal([...report.claims,...report.smallDivision].find((c:any)=>c.claim===claimName)?.result,'sat');
    const book=await checkedBook(`${dir}/wide.bend`);
    const args=root==='divide'?[wideWord(inputs[0]),word(inputs[1])]:inputs.map(word);
    const result=B.term_snf(book,args.reduce((f,x)=>B.App(f,x),B.Ref(root)));
    assert.equal(result.$,'Ctr');
    let actual:unknown;
    if(result.k==='math.Err'||result.k==='math.DivErr')actual={error:B.u32_from_term(result.x[0])};
    else if(result.k==='math.Ok')actual={value:unpack(result.x[0])};
    else {assert.equal(result.k,'math.DivOk');const pair=result.x[0];assert.equal(pair.$,'Ctr');
      actual={quotient:unpack(pair.x[0]),remainder:unpack(pair.x[1])};}
    const n=root==='divide'?inputs[0]:inputs[0]*inputs[1];
    const d=root==='divide'?inputs[1]:inputs[2]!;
    let expected:unknown;
    if(d===0n)expected={error:3};
    else {
      const q=n/d,r=n%d;
      const rounded=q+(root==='ceil'&&r!==0n?1n:0n);
      expected=rounded>mask?{error:1}:root==='divide'||root==='mul_div'?{quotient:q.toString(),remainder:r.toString()}:{value:rounded.toString()};
    }
    assert.notDeepEqual(actual,expected,'Mutation must have a concrete Bend witness');
    mutations.push({name,...report,concreteWitness:{inputs:inputs.map(String),bend:actual,mathematical:expected}});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
assert.deepEqual(inputHashes(),hashes,'Wide proof inputs changed during qualification');
const pendingPath=`${attemptPath}/pending.json`;
fs.writeFileSync(pendingPath,JSON.stringify({bendCommit:BEND_COMMIT,positive,mutations,hashes},null,2)+'\n');
fs.renameSync(pendingPath,reportPath);
console.log(`Wide refinement passed: product/loop prerequisites, 33 division fast-path lemmas, 9 width-bridge lemmas 15 small-divisor claims and 12 API obligations; ${mutations.length} mutations rejected with concrete Bend witnesses`);
