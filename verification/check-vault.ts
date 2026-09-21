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
async function run(source:string,stem:string,status:number) {
  fs.writeFileSync(stem+'.model.json',JSON.stringify(await model(source,['process']))+'\n');
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/vault.py',stem+'.model.json'],{encoding:'utf8'});
  assert.equal(result.status,status,result.stderr||result.stdout);
  const report=JSON.parse(result.stdout);assert.equal(report.claims.length,8);
  assert.ok(report.claims.every((c:any)=>['sat','unsat'].includes(c.result)),'Timeouts are failures');
  if(status===0)assert.ok(report.claims.every((c:any)=>c.result==='unsat'));
  return report;
}
const positive=await run('examples/vault/vault.bend','build/vault-refinement',0);
const source=fs.readFileSync('examples/vault/vault.bend','utf8');
const M='../../sdk/math.',S='../../sdk/context.',F='../../sdk/effects.';
const c=(name:string,...args:any[])=>B.Ctr(name,args);
const u32=(n:bigint)=>B.term_higher(B.u32_to_term(Number(n)));
const word=(n:bigint)=>c(M+'U64',u32(n&0xffffffffn),u32(n>>32n));
const key=(n:bigint)=>c(S+'Key',...Array.from({length:8},(_,i)=>u32((n>>BigInt(32*i))&0xffffffffn)));
function plain(t:any):any {assert.equal(t.$,'Ctr');return t.k==='U32'?B.u32_from_term(t):{constructor:t.k,fields:t.x.map(plain)};}
const mutations=[];
for(const [name,before,after,target] of [
  ['missing owner signature','Bool.and(signed, Sol.equal(actor, owner))','Sol.equal(actor, owner)','vault-1-Deposit'],
  ['inverted owner check','Sol.equal(actor, owner)','Bool.not(Sol.equal(actor, owner))','vault-1-Withdraw'],
  ['zero deposit transfer','amount, Fx.Actor{}','Math.zero(), Fx.Actor{}','vault-1-Deposit'],
  ['withdraw adds balance','Math.sub(balance, amount)','Math.add(balance, amount)','vault-1-Withdraw'],
  ['nonzero initial balance','Live{actor, mint, Math.zero()}','Live{actor, mint, Math.U64{1, 0}}','vault-0-Initialize'],
]) {
  const dir=fs.mkdtempSync('build/vault-refinement-negative-');
  try {
    assert.equal(source.split(before).length,2);
    const path=`${dir}/vault.bend`;fs.writeFileSync(path,source.replace(before,after));
    const report=await run(path,`${dir}/result`,1);
    const claim=report.claims.find((c:any)=>c.claim===target);assert.equal(claim?.result,'sat');
    const n=Object.fromEntries(Object.entries(claim.counterexample).map(([k,v])=>[k,BigInt(v as string)]));
    const [,live,ins]=target.split('-');
    const state=live==='1'?c('Live',key(n.owner),key(n.mint),word(n.balance)):c('Empty');
    const instruction=c(ins,ins==='Initialize'?key(n.init_mint):word(n.amount));
    const context=c(S+'Context',key(n.actor),c(n.signed===1n?'True':'False'),word(n.slot));
    const reject=(code:number)=>c('Rejected',u32(BigInt(code)));
    const accepted=(owner:bigint,mint:bigint,balance:bigint,effect:any)=>c('Accepted',c('Live',key(owner),key(mint),word(balance)),c(F+'Effects',effect,c(F+'None')));
    let expected:any;
    if(live==='0')expected=ins==='Initialize'?(n.signed===0n?reject(1):accepted(n.actor,n.init_mint,0n,c(F+'CheckMint',u32(4n),key(n.init_mint)))):reject(2);
    else if(n.signed===0n||n.actor!==n.owner)expected=reject(1);
    else if(ins==='Initialize')expected=reject(3);
    else {
      const deposit=ins==='Deposit';const balance=deposit?n.balance+n.amount:n.balance-n.amount;
      if(balance<0n||balance>=(1n<<64n))expected=reject(deposit?4:5);
      else {
        const effect=c(F+'Transfer',u32(4n),u32(5n),u32(6n),key(n.mint),c(F+(deposit?'ToCustody':'ToActor')),word(n.amount),c(F+(deposit?'Actor':'Custody')));
        expected=accepted(n.owner,n.mint,balance,effect);
      }
    }
    const book=await checkedBook(path);
    const actual=B.term_snf(book,[context,state,instruction].reduce((f,x)=>B.App(f,x),B.Ref('process')));
    const bend=plain(actual),mathematical=plain(expected);assert.notDeepEqual(bend,mathematical,'Solver inputs must reproduce the full source outcome mismatch');
    claim.replay={bend,mathematical};mutations.push({name,...report});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
const files=['examples/vault/vault.bend','sdk/math.bend','sdk/effects.bend','sdk/context.bend','compiler/primitives.ts','verification/model.ts','verification/prove.py','verification/division_loop.py','verification/multiplication.py','verification/vault.py','verification/check-vault.ts'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/vault-refinement.json',JSON.stringify({bendCommit:BEND_COMMIT,positive,mutations,hashes},null,2)+'\n');
console.log('Vault full-source refinement passed: six dispatch cases and two conservation equations; five counterexamples replayed in Bend');
