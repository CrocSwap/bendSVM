import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { prepareBend, BEND_COMMIT } from '../scripts/build.ts';
prepareBend();
const { model } = await import('./model.ts');
const { checkedBook } = await import('../compiler/backend.ts');
const B = await import('../.deps/bend/bend2/bend.ts');
fs.mkdirSync('build', { recursive: true });
const mathPath='build/amm-pricing-refinement.math.model.json',widePath='build/amm-pricing-refinement.wide.model.json';
fs.writeFileSync(mathPath,JSON.stringify(await model('sdk/math.bend',['mul32_parts','mul32','mul_parts','mul'])));
fs.writeFileSync(widePath,JSON.stringify(await model('sdk/wide.bend',['add','product_parts','product','divide','mul_div','floor','ceil'])));
const roots=['fee','swap','deposit','withdraw'];
async function check(source:string,stem:string,status:number) {
  fs.writeFileSync(stem+'.model.json',JSON.stringify(await model(source,roots)));
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/amm_pricing.py',stem+'.model.json',mathPath,widePath],{encoding:'utf8'});
  assert.equal(result.status,status,result.stderr||result.stdout);
  const report=JSON.parse(result.stdout);
  assert.equal(report.claims.length,11);
  assert.equal(report.checkedArithmetic.length,2);
  assert(report.checkedArithmetic.every((c:any)=>c.result==='unsat'));
  assert(report.bindings.every((b:any)=>b.result==='checked'));
  assert.equal(report.wide.claims.length,6);
  assert(report.wide.claims.every((c:any)=>c.result==='unsat'));
  assert(report.claims.every((c:any)=>['sat','unsat'].includes(c.result)),'UNKNOWN cannot pass');
  if(status===0)assert(report.claims.every((c:any)=>c.result==='unsat'));
  else assert(report.claims.some((c:any)=>c.result==='sat'));
  return report;
}
const positive=await check('examples/amm/pricing.bend','build/amm-pricing-refinement',0);
const source=fs.readFileSync('examples/amm/pricing.bend','utf8');
const M='../../sdk/math.';
const ctor=(name:string,...args:any[])=>B.Ctr(name,args);
const u32=(n:bigint)=>B.term_higher(B.u32_to_term(Number(n)));
const word=(n:bigint)=>ctor(M+'U64',u32(n&0xffffffffn),u32(n>>32n));
const ok=(n:bigint)=>ctor(M+'Ok',word(n));
const err=(n:bigint)=>ctor(M+'Err',u32(n));
function plain(t:any):any {assert.equal(t.$,'Ctr');return t.k==='U32'?B.u32_from_term(t):{constructor:t.k,fields:t.x.map(plain)};}
const max=(1n<<64n)-1n,mutations=[];
const cases:[string,string,string,string,bigint[],any,string][]=[
  ['wrong fee','Math.U64{30, 0}','Math.U64{300, 0}','fee',[1000n],ok(3n),'amm-fee-routing'],
  ['wrong output reserve','output_with_denominator(output, amount, Math.add(input, amount))','output_with_denominator(input, amount, Math.add(input, amount))','swap',[10000n,20000n,1000n],ok(1813n),'amm-swap-routing'],
  ['missing gross capacity','Math.add(input, gross)','Math.Ok{input}','swap',[max-1000n,max,1001n],err(1n),'amm-swap-routing'],
  ['wrong deposit ratio','Wide.ceil(reserve, shares, supply)','Wide.ceil(supply, shares, reserve)','deposit',[10n,1n,3n],ok(4n),'amm-deposit-routing'],
  ['wrong withdrawal ratio','Wide.floor(reserve, shares, supply)','Wide.floor(reserve, supply, shares)','withdraw',[10n,3n,7n],ok(4n),'amm-withdraw-routing'],
  ['zero output accepted','      Math.Err{4}\n    case True{}:\n      Math.Ok{amount}','      Math.Ok{amount}\n    case True{}:\n      Math.Ok{amount}','swap',[10000n,1n,2n],err(4n),'amm-swap-routing'],
];
for(const [name,before,after,root,args,expected,claim] of cases) {
  const directory=fs.mkdtempSync('examples/.amm-pricing-negative-');
  try {
    assert.equal(source.split(before).length,2,name);
    let mutated = source.replace(before,after);
    if (name === 'wrong output reserve') mutated = mutated.replace('def output_with_effective(input:', 'def output_with_effective(+input:');
    const path=`${directory}/pricing.bend`;fs.writeFileSync(path,mutated);
    const report=await check(path,`build/amm-pricing-negative-${mutations.length}`,1);
    assert.equal(report.claims.find((c:any)=>c.claim===claim).result,'sat');
    const book=await checkedBook(path);
    const call=args.reduce((f,n)=>B.App(f,word(n)),B.Ref(root));
    const actual=plain(B.term_snf(book,call)),mathematical=plain(expected);
    assert.notDeepEqual(actual,mathematical,name);
    mutations.push({name,report,concreteWitness:{root,args:args.map(String),actual,expected:mathematical}});
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
}
for(const root of ['floor','ceil']) {
  const corrupted=JSON.parse(fs.readFileSync('build/amm-pricing-refinement.model.json','utf8'));
  corrupted.functions[`../../sdk/wide.${root}`].body=null;
  const path=`build/amm-pricing-negative-${root}-binding.model.json`;fs.writeFileSync(path,JSON.stringify(corrupted));
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/amm_pricing.py',path,mathPath,widePath],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Imported .* definition mismatch/);
}
const files=['examples/amm/pricing.bend','sdk/math.bend','sdk/wide.bend','compiler/primitives.ts','compiler/backend.ts','compiler/schema.ts','package.json','package-lock.json',
  'verification/model.ts','verification/prove.py','verification/multiplication.py','verification/division_step.py',
  'verification/division_loop.py','verification/wide.py','verification/vesting_process.py','verification/amm_pricing.py','verification/check-amm-pricing.ts'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/amm-pricing-refinement.json',JSON.stringify({bendCommit:BEND_COMMIT,positive,mutations,importMismatchesRejected:true,hashes},null,2)+'\n');
console.log('AMM pricing refinement: 11 obligations, six SAT mutations with concrete Bend witnesses and import negatives passed');
