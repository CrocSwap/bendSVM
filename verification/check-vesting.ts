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
async function run(source:string,stem:string,status:number) {
  fs.writeFileSync(stem+'.model.json',JSON.stringify(await model(source,['claim_result','initialize_instruction']))+'\n');
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/vesting.py',stem+'.model.json'],{encoding:'utf8'});
  assert.equal(result.status,status,result.stderr||result.stdout);
  const report=JSON.parse(result.stdout);
  assert.equal(report.claims.length,4);
  assert.ok(report.claims.every((c:any)=>['sat','unsat'].includes(c.result)));
  if(status===0)assert.ok(report.claims.every((c:any)=>c.result==='unsat'));
  return report;
}
const positive=await run('examples/vesting/vesting.bend','build/vesting-refinement',0);
const source=fs.readFileSync('examples/vesting/vesting.bend','utf8');
const math='../../sdk/math.',fx='../../sdk/effects.';
const u32=(n:bigint)=>B.term_higher(B.u32_to_term(Number(n)));
const c=(name:string,...args:any[])=>B.Ctr(name,args);
const word=(n:bigint)=>c(math+'U64',u32(n&0xffffffffn),u32(n>>32n));
const key=(n:bigint)=>c('../../sdk/context.Key',...Array.from({length:8},()=>u32(n)));
const beneficiary=key(0n),mint=key(1n);
function plain(t:any):any {
  assert.equal(t.$,'Ctr');
  return t.k==='U32'?B.u32_from_term(t):{constructor:t.k,fields:t.x.map(plain)};
}
const mutations=[];
for(const [name,before,after,target] of [
  ['reset claimed amount','delta(Schedule{beneficiary, mint, total, start, end, vested}','delta(Schedule{beneficiary, mint, total, start, end, Math.zero()}','vesting-exact-payout'],
  ['reversed funding cap','Math.less(funded_total(schedule), vested)','Math.less(vested, funded_total(schedule))','vesting-exact-payout'],
  ['wrong payout authority','amount, Fx.Custody{}','amount, Fx.Actor{}','vesting-exact-payout'],
  ['unfunded initialization','total, Fx.Actor{}','Math.zero(), Fx.Actor{}','vesting-exact-funding'],
]) {
  const dir=fs.mkdtempSync('build/vesting-refinement-negative-');
  try {
    assert.equal(source.split(before).length,2);
    const path=`${dir}/vesting.bend`;fs.writeFileSync(path,source.replace(before,after));
    const report=await run(path,`${dir}/result`,1);
    const claim=report.claims.find((c:any)=>c.claim===target);assert.equal(claim?.result,'sat');
    const n=Object.fromEntries(Object.entries(claim.counterexample).map(([k,v])=>[k,BigInt(v as string)]));
    const schedule=(amount:bigint)=>c('Schedule',beneficiary,mint,word(n.total),word(n.start??0n),word(n.end??1n),word(amount));
    const reject=(code:number)=>c('Rejected',u32(BigInt(code)));
    function accepted(amount:bigint,claimed:bigint,initial=false) {
      const effect=c(fx+'Transfer',u32(4n),u32(5n),u32(6n),mint,initial?c(fx+'ToCustody'):c(fx+'ToOwner',beneficiary),word(amount),c(fx+(initial?'Actor':'Custody')));
      return c('Accepted',c('Live',schedule(claimed)),c(fx+'Effects',effect,c(fx+'None')));
    }
    let root:string,args:any[],expected:any;
    if(target==='vesting-exact-funding') {
      root='initialize_instruction';args=[c(n.signed===1n?'True':'False'),c('Initialize',beneficiary,mint,word(n.total),word(n.start),word(n.end))];
      expected=n.signed===0n?reject(1):n.start>=n.end||n.total===0n?reject(3):accepted(n.total,0n,true);
    } else {
      root='claim_result';args=[schedule(n.claimed),c(math+'Ok',word(n.vested))];
      expected=n.vested>n.total?reject(4):n.vested<n.claimed?reject(5):n.vested===n.claimed?reject(6):accepted(n.vested-n.claimed,n.vested);
    }
    const book=await checkedBook(path);
    const actual=B.term_snf(book,args.reduce((f,x)=>B.App(f,x),B.Ref(root)));
    const bend=plain(actual),mathematical=plain(expected);
    assert.notDeepEqual(bend,mathematical,'Counterexample must replay through Bend');
    claim.replay={bend,mathematical};mutations.push({name,...report});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
const files=['examples/vesting/vesting.bend','sdk/math.bend','sdk/effects.bend','sdk/context.bend','verification/model.ts','verification/prove.py','verification/division_loop.py','verification/multiplication.py','verification/vesting.py','verification/check-vesting.ts','compiler/primitives.ts'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/vesting-refinement.json',JSON.stringify({bendCommit:BEND_COMMIT,positive,mutations,hashes},null,2)+'\n');
console.log('Vesting funding/payout refinement passed: four obligations; four source mutations replayed in Bend');
