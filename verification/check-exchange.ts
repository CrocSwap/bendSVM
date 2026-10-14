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
const mathPath='build/exchange-refinement.math.model.json',widePath='build/exchange-refinement.wide.model.json';
fs.writeFileSync(mathPath,JSON.stringify(await model('sdk/math.bend',['mul32_parts','mul32','mul_parts','mul','div_step','div2','div4','div8','div16','div32','div64','divmod','div','mod']))+'\n');
fs.writeFileSync(widePath,JSON.stringify(await model('sdk/wide.bend',['add','product_parts','product','divide','mul_div','floor','ceil']))+'\n');
async function run(source:string,stem:string,status:number) {
  fs.writeFileSync(stem+'.model.json',JSON.stringify(await model(source,['process']))+'\n');
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/exchange.py',stem+'.model.json',mathPath,widePath],{encoding:'utf8'});
  assert.equal(result.status,status,result.stderr||result.stdout);
  const report=JSON.parse(result.stdout);assert.equal(report.binding.result,'checked');
  // Keep the prerequisite results (including solver-unknown reasons) in a failure log.
  const wideDiagnostic=JSON.stringify({source,wide:report.wide},null,2);
  assert.equal(report.wide.smallDivision.length,15);
  assert.ok(report.wide.smallDivision.every((c:any)=>c.result==='unsat'));
  assert.deepEqual(report.wide.claims.map((c:any)=>c.claim),["wide-quotient-overflow-threshold","integer-floor-ceiling","wide-divide-wrapper","wide-zero-precedence","wide-overflow-error","wide-divisor-one","wide-native64-route","wide-small32-route","wide-div64-route","mul-div-composition","floor-wrapper","ceil-wrapper"]);
  assert.equal(report.wide.fastPaths.length,33,wideDiagnostic);assert.ok(report.wide.fastPaths.every((c:any)=>c.result==='unsat'),wideDiagnostic);
  assert.equal(report.wide.claims.length,12,wideDiagnostic);assert.ok(report.wide.claims.every((c:any)=>c.result==='unsat'),wideDiagnostic);
  assert.equal(report.claims.length,11);assert.ok(report.claims.every((c:any)=>['sat','unsat'].includes(c.result)));
  if(status===0)assert.ok(report.claims.every((c:any)=>c.result==='unsat'));
  return report;
}
const positive=await run('examples/exchange/exchange.bend','build/exchange-refinement',0);
const source=fs.readFileSync('examples/exchange/exchange.bend','utf8');
const M='../../sdk/math.',S='../../sdk/context.',F='../../sdk/effects.';
const c=(name:string,...args:any[])=>B.Ctr(name,args);
const u32=(n:bigint)=>B.term_higher(B.u32_to_term(Number(n)));
const word=(n:bigint)=>c(M+'U64',u32(n&0xffffffffn),u32(n>>32n));
const key=(n:bigint)=>c(S+'Key',...Array.from({length:8},()=>u32(n)));
function plain(t:any):any {assert.equal(t.$,'Ctr');return t.k==='U32'?B.u32_from_term(t):{constructor:t.k,fields:t.x.map(plain)};}
const mutations=[];
for(const [name,before,after,ins,signed] of [
  ['unsigned fill','authorize(signed, fill(offer, amount, max_payment))','authorize(True{}, fill(offer, amount, max_payment))','Fill',false],
  ['inverted cancellation owner','Sol.equal(actor, maker)','Bool.not(Sol.equal(actor, maker))','Cancel',true],
  ['reversed slippage','Bool.not(Math.less(max_payment, payment))','Math.less(max_payment, payment)','Fill',true],
  ['fill increases inventory','Math.sub_wrap(remaining, amount)','Math.add_wrap(remaining, amount)','Fill',true],
  ['zero quote transfer','payment, Fx.Actor{}','Math.zero(), Fx.Actor{}','Fill',true],
  ['inverted price ratio','Wide.ceil(amount, numerator, denominator)','Wide.ceil(amount, denominator, numerator)','Fill',true],
] as const) {
  const dir=fs.mkdtempSync('build/exchange-refinement-negative-');
  try {
    assert.equal(source.split(before).length,2);
    const path=`${dir}/exchange.bend`;fs.writeFileSync(path,source.replace(before,after));
    const report=await run(path,`${dir}/result`,1);
    assert.equal(report.claims.find((c:any)=>c.claim===`exchange-Open-${ins}`)?.result,'sat');
    const maker=key(1n),actor=key(2n),base=key(3n),quote=key(4n);
    const remaining=10n,amount=2n,numerator=3n,denominator=2n,maximum=3n;
    const offer=(left:bigint)=>c('Offer',maker,base,quote,word(left),word(numerator),word(denominator));
    const instruction=ins==='Fill'?c('Fill',word(amount),word(maximum)):c('Cancel');
    const context=c(S+'Context',actor,c(signed?'True':'False'),word(0n));
    const book=await checkedBook(path);
    const actual=B.term_snf(book,[context,c('Open',offer(remaining)),instruction].reduce((f,x)=>B.App(f,x),B.Ref('process')));
    let expected:any;
    if(!signed||ins==='Cancel')expected=c('Rejected',u32(1n));
    else {
      const payment=(amount*numerator+denominator-1n)/denominator;
      assert.ok(payment>0n&&payment<=maximum);
      const first=c(F+'Transfer',u32(4n),u32(5n),u32(6n),quote,c(F+'ToOwner',maker),word(payment),c(F+'Actor'));
      const second=c(F+'Transfer',u32(7n),u32(8n),u32(9n),base,c(F+'ToActor'),word(amount),c(F+'Custody'));
      expected=c('Accepted',c('Open',offer(remaining-amount)),c(F+'Effects',first,second));
    }
    const bend=plain(actual),mathematical=plain(expected);assert.notDeepEqual(bend,mathematical);
    mutations.push({name,...report,concreteWitness:{instruction:ins,signed,maker:'1 repeated',actor:'2 repeated',remaining:'10',amount:'2',numerator:'3',denominator:'2',maximum:'3',bend,mathematical}});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
const dir=fs.mkdtempSync('build/exchange-binding-negative-');
try {
  const altered=JSON.parse(fs.readFileSync('build/exchange-refinement.model.json','utf8'));
  altered.functions['../../sdk/wide.ceil_result'].body=null;
  const path=`${dir}/model.json`;fs.writeFileSync(path,JSON.stringify(altered));
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/exchange.py',path,mathPath,widePath],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Imported ceil definition mismatch/);
} finally {fs.rmSync(dir,{recursive:true,force:true});}
const files=['examples/exchange/exchange.bend','sdk/math.bend','sdk/wide.bend','sdk/context.bend','sdk/effects.bend','compiler/primitives.ts','verification/model.ts','verification/prove.py','verification/division_step.py','verification/division_loop.py','verification/multiplication.py','verification/wide.py','verification/wide_division.py','verification/small_division.py','verification/vesting.py','verification/vesting_process.py','verification/exchange.py','verification/check-exchange.ts'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/exchange-refinement.json',JSON.stringify({bendCommit:BEND_COMMIT,positive,mutations,importMismatchRejected:true,hashes},null,2)+'\n');
console.log('Exchange full-source refinement passed: nine dispatch cases, inventory conservation and ceiling-price bounds; six mutations have concrete Bend witnesses');
