import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {prepareBend,BEND_COMMIT} from '../scripts/build.ts';
prepareBend();
const {model}=await import('./model.ts');
const {checkedBook}=await import('../compiler/backend.ts');
const B=await import('../.deps/bend/bend2/bend.ts');
fs.mkdirSync('build',{recursive:true});
const mathPath='build/vesting-process.math.model.json',widePath='build/vesting-process.wide.model.json';
fs.writeFileSync(mathPath,JSON.stringify(await model('sdk/math.bend',['mul32_parts','mul32','mul_parts','mul']))+'\n');
fs.writeFileSync(widePath,JSON.stringify(await model('sdk/wide.bend',['add','product_parts','product','divide','mul_div','floor','ceil']))+'\n');
async function run(source:string,stem:string,status:number) {
  fs.writeFileSync(stem+'.model.json',JSON.stringify(await model(source,['process']))+'\n');
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/vesting_process.py',stem+'.model.json',mathPath,widePath],{encoding:'utf8'});
  assert.equal(result.status,status,result.stderr||result.stdout);
  const report=JSON.parse(result.stdout);
  assert.equal(report.binding.result,'checked');
  assert.ok(report.payout.claims.every((c:any)=>c.result==='unsat'));
  assert.equal(report.wide.claims.length,6);assert.ok(report.wide.claims.every((c:any)=>c.result==='unsat'));
  assert.ok(report.claims.every((c:any)=>['sat','unsat'].includes(c.result)));
  if(status===0){assert.equal(report.claims.length,6);assert.ok(report.claims.every((c:any)=>c.result==='unsat'));}
  return report;
}
const positive=await run('examples/vesting/vesting.bend','build/vesting-process',0);
// This is a verifier-binding test, distinct from checked source mutations below.
// A changed imported definition must not inherit the separately proved theorem.
const bindingDir=fs.mkdtempSync('build/vesting-binding-negative-');
try {
  const altered=JSON.parse(fs.readFileSync('build/vesting-process.model.json','utf8'));
  altered.functions['../../sdk/math.mul32'].body=null;
  const path=`${bindingDir}/model.json`;fs.writeFileSync(path,JSON.stringify(altered));
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/vesting_process.py',path,mathPath,widePath],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Imported floor definition mismatch/);
} finally {fs.rmSync(bindingDir,{recursive:true,force:true});}
const source=fs.readFileSync('examples/vesting/vesting.bend','utf8');
const M='../../sdk/math.',S='../../sdk/context.',F='../../sdk/effects.';
const c=(name:string,...args:any[])=>B.Ctr(name,args);
const u32=(n:bigint)=>B.term_higher(B.u32_to_term(Number(n)));
const word=(n:bigint)=>c(M+'U64',u32(n&0xffffffffn),u32(n>>32n));
const key=(n:bigint)=>c(S+'Key',...Array.from({length:8},()=>u32(n)));
const beneficiary=key(0n),mint=key(1n);
function plain(t:any):any {assert.equal(t.$,'Ctr');return t.k==='U32'?B.u32_from_term(t):{constructor:t.k,fields:t.x.map(plain)};}
const mutations=[];
for(const [name,before,after,target,signed] of [
  ['missing signature check','Bool.and(signed, Sol.equal(actor, beneficiary))','Sol.equal(actor, beneficiary)','vesting-process-1-1',false],
  ['inverted beneficiary check','Sol.equal(actor, beneficiary)','Bool.not(Sol.equal(actor, beneficiary))','vesting-process-1-1',true],
  ['inverted start guard','Bool.not(Math.less(start, now))','Math.less(start, now)','vesting-entitlement-routing',true],
  ['reversed duration','Math.sub_wrap(end, start)','Math.sub_wrap(start, end)','vesting-entitlement-routing',true],
] as const) {
  const dir=fs.mkdtempSync('build/vesting-process-negative-');
  try {
    assert.equal(source.split(before).length,2);
    const path=`${dir}/vesting.bend`;fs.writeFileSync(path,source.replace(before,after));
    const report=await run(path,`${dir}/result`,1);
    assert.equal(report.claims.find((c:any)=>c.claim===target)?.result,'sat');
    const schedule=(claimed:bigint)=>c('Schedule',beneficiary,mint,word(100n),word(0n),word(10n),word(claimed));
    const context=c(S+'Context',beneficiary,c(signed?'True':'False'),word(5n));
    const args=[context,c('Live',schedule(0n)),c('Claim')];
    const book=await checkedBook(path);
    const actual=B.term_snf(book,args.reduce((f,x)=>B.App(f,x),B.Ref('process')));
    const vested=100n*(5n-0n)/(10n-0n);
    const effect=c(F+'Transfer',u32(4n),u32(5n),u32(6n),mint,c(F+'ToOwner',beneficiary),word(vested),c(F+'Custody'));
    const expected=signed?c('Accepted',c('Live',schedule(vested)),c(F+'Effects',effect,c(F+'None'))):c('Rejected',u32(1n));
    const bend=plain(actual),mathematical=plain(expected);assert.notDeepEqual(bend,mathematical);
    mutations.push({name,...report,concreteWitness:{total:'100',start:'0',end:'10',claimed:'0',now:'5',signed,actorEqualsBeneficiary:true,bend,mathematical}});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
const files=['examples/vesting/vesting.bend','sdk/math.bend','sdk/wide.bend','sdk/context.bend','sdk/effects.bend','compiler/primitives.ts','verification/model.ts','verification/prove.py','verification/division_step.py','verification/division_loop.py','verification/multiplication.py','verification/wide.py','verification/vesting.py','verification/vesting_process.py','verification/check-vesting-process.ts'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/vesting-process.json',JSON.stringify({bendCommit:BEND_COMMIT,positive,mutations,importMismatchRejected:true,hashes},null,2)+'\n');
console.log('Vesting entrypoint refinement passed: bound arithmetic imports, entitlement and four dispatch cases; four mutations have concrete Bend witnesses');
