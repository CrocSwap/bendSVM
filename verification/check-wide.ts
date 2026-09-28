import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {prepareBend,BEND_COMMIT} from '../scripts/build.ts';

prepareBend();
const {model}=await import('./model.ts');
const {checkedBook}=await import('../compiler/backend.ts');
const B=await import('../.deps/bend/bend2/bend.ts');
fs.mkdirSync('build',{recursive:true});
const roots=['add','product_parts','product','divide','mul_div','floor','ceil'];
const mathPath='build/wide-refinement.math.model.json';
fs.writeFileSync(mathPath,JSON.stringify(await model('sdk/math.bend',['mul32_parts','mul32','mul_parts','mul']))+'\n');
async function run(source:string,stem:string,status:number) {
  fs.writeFileSync(stem+'.model.json',JSON.stringify(await model(source,roots))+'\n');
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/wide.py',mathPath,stem+'.model.json'],{encoding:'utf8'});
  assert.equal(result.status,status,result.stderr||result.stdout);
  const report=JSON.parse(result.stdout);
  assert.equal(report.multiplication.claims.length,14);
  assert.ok(report.multiplication.claims.every((c:any)=>c.result==='unsat'));
  assert.equal(report.loop.step.result,'unsat');
  assert.equal(report.loop.induction.length,68);
  assert.ok(report.loop.induction.every((c:any)=>c.result==='unsat'));
  assert.equal(report.fastPaths.length,33);
  assert.ok(report.fastPaths.every((c:any)=>c.result==='unsat'));
  assert.ok(report.claims.every((c:any)=>['sat','unsat'].includes(c.result)),'Timeout is not a pass');
  if(status===0) {
    assert.equal(report.claims.length,12);
    assert.deepEqual(report.claims.map((c:any)=>c.claim),[
      'wide-quotient-overflow-threshold','integer-floor-ceiling',
      'wide-divide-wrapper','wide-zero-precedence','wide-overflow-error',
      'wide-divisor-one','wide-div32-route','wide-div64-route','wide-div64-nonzero-high',
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
  ['lost high dividend','Math.DivState{low, high, divisor}','Math.DivState{low, Math.zero(), divisor}','wide-divide-wrapper','divide',[(1n<<64n)+1n,2n]],
  ['reversed overflow guard','Math.less(high, divisor)','Math.less(divisor, high)','wide-divide-wrapper','divide',[5n,2n]],
  ['wrong zero-divisor error','Math.DivErr{3}','Math.DivErr{0}','wide-divide-wrapper','divide',[5n,0n]],
  ['wrong composed divisor','divide(product(a, b), divisor)','divide(product(a, divisor), b)','mul-div-composition','mul_div',[6n,4n,3n]],
  ['floor returns remainder','Math.quotient(mul_div(a, b, divisor))','Math.remainder(mul_div(a, b, divisor))','floor-wrapper','floor',[6n,4n,4n]],
  ['reversed exact-rounding guard','round_up(Math.equal(r, Math.zero()), q)','round_up(Bool.not(Math.equal(r, Math.zero())), q)','ceil-wrapper','ceil',[1n,1n,1n]],
  ['ceiling drops increment','Math.add(quotient, Math.U64{1, 0})','Math.Ok{quotient}','ceil-wrapper','ceil',[1n,1n,2n]],
  ['short route with nonzero high','Math.equal(high, Math.zero())','Math.equal(high, Math.U64{1, 0})','wide-divide-wrapper','divide',[(1n<<64n)+1n,2n]],
  ['short route with large prefix','Bool.or(U32.is_zero(lhi), Bool.not(U32.is_zero(dhi)))','Bool.or(U32.is_zero(lhi), U32.is_zero(dhi))','wide-divide-wrapper','divide',[(2n<<32n)+1n,2n]],
  ['wrong short quotient register','Math.U64{0, lo}, Math.U64{hi, 0}','Math.U64{0, 0}, Math.U64{hi, 0}','wide-divide-wrapper','divide',[(2n<<32n)+1n,1n<<32n]],
  ['wrong short remainder register','Math.U64{0, lo}, Math.U64{hi, 0}','Math.U64{0, lo}, Math.zero()','wide-divide-wrapper','divide',[(2n<<32n)+1n,1n<<32n]],
  ['zero guard loses precedence','divide_guard(Math.equal(divisor, Math.zero()), value, divisor)','divide_guard(Math.equal(divisor, Math.U64{1, 0}), value, divisor)','wide-divide-wrapper','divide',[(1n<<64n)+1n,0n]],
] as const) {
  const dir=fs.mkdtempSync('build/wide-negative-');
  try {
    assert.equal(wide.split(before).length,2,'Mutation must have exactly one target');
    fs.writeFileSync(`${dir}/math.bend`,math);
    fs.writeFileSync(`${dir}/wide.bend`,wide.replace(before,after));
    const report=await run(`${dir}/wide.bend`,`${dir}/result`,1);
    assert.equal(report.claims.find((c:any)=>c.claim===claimName)?.result,'sat');
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
const files=['sdk/math.bend','sdk/wide.bend','verification/model.ts','verification/prove.py','verification/division_step.py','verification/division_loop.py','verification/multiplication.py','verification/wide.py','verification/check-wide.ts','compiler/primitives.ts'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/wide-refinement.json',JSON.stringify({bendCommit:BEND_COMMIT,positive,mutations,hashes},null,2)+'\n');
console.log(`Wide refinement passed: product/loop prerequisites, 33 fast-path lemmas and 12 API obligations; ${mutations.length} mutations rejected with concrete Bend witnesses`);
