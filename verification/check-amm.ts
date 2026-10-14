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
const prerequisites = [
  ['pricing', 'examples/amm/pricing.bend', ['fee','swap','deposit','withdraw']],
  ['sqrt', 'sdk/sqrt.bend', ['floor','geometric_mean']],
  ['math', 'sdk/math.bend', ['mul32_parts','mul32','mul_parts','mul','div_step','div2','div4','div8','div16','div32','div64','divmod','div','mod']],
  ['wide', 'sdk/wide.bend', ['add','product_parts','product','divide','mul_div','floor','ceil']],
] as const;
const paths: Record<string,string> = {};
for (const [name, source, roots] of prerequisites) {
  paths[name] = `build/amm-refinement.${name}.model.json`;
  fs.writeFileSync(paths[name], JSON.stringify(await model(source, [...roots])));
}
// The sqrt proof and pricing proof can use the same independently exported
// standalone math/wide models; their namespace bindings remain separate.
const args = [paths.pricing, paths.sqrt, paths.math, paths.wide, paths.math, paths.wide];
function invoke(path: string) {
  return spawnSync(process.env.PYTHON ?? 'python3', ['-B','verification/amm.py',path,...args], { encoding:'utf8' });
}
async function check(source: string, stem: string, status: number) {
  fs.writeFileSync(stem+'.model.json', JSON.stringify(await model(source,['process'])));
  const result=invoke(stem+'.model.json');
  assert.ifError(result.error);
  assert.equal(result.status,status,result.stderr||result.stdout);
  assert(result.stdout.trim().startsWith('{'), result.stderr || 'Missing proof report');
  const report=JSON.parse(result.stdout);
  assert.equal(report.claims.length,32);
  assert.equal(report.bindings.length,4);
  assert.equal(report.schema.result,'checked');
  assert(report.bindings.every((b:any)=>b.result==='checked'));
  assert.equal(report.pricing.claims.length,11);
  assert.equal(report.sqrt.claims.length,71);
  assert.equal(report.sqrt.checkedHelpers.length,3);
  assert.equal(report.pricing.checkedArithmetic.length,2);
  assert([...report.sqrt.checkedHelpers,...report.pricing.checkedArithmetic].every((c:any)=>c.result==='unsat'));
  assert([...report.pricing.claims,...report.sqrt.claims].every((c:any)=>c.result==='unsat'));
  assert(report.claims.every((c:any)=>['sat','unsat'].includes(c.result)),'UNKNOWN cannot pass');
  if(status===0)assert(report.claims.every((c:any)=>c.result==='unsat'));
  else assert(report.claims.some((c:any)=>c.result==='sat'));
  return report;
}
const positive=await check('examples/amm/amm.bend','build/amm-refinement',0);
const source=fs.readFileSync('examples/amm/amm.bend','utf8');
const M='../../sdk/math.',S='../../sdk/context.',F='../../sdk/effects.',T='../../sdk/issuance.';
const c=(name:string,...args:any[])=>B.Ctr(name,args);
const u=(n:bigint|number)=>B.term_higher(B.u32_to_term(Number(n)));
const w=(n:bigint)=>c(M+'U64',u(n&0xffffffffn),u(n>>32n));
const key=(n:number)=>c(S+'Key',...Array.from({length:8},()=>u(n)));
const config=()=>c('Config',...Array.from({length:5},(_,i)=>key(i+1)));
const pool=(x:bigint,y:bigint,l:bigint)=>c('Pool',config(),c('Balances',w(x),w(y),w(l)));
function transfer(base:boolean,incoming:boolean,amount:bigint) {
  const [user,reserve,mint]=base?[4,5,6]:[7,8,9];
  return c(T+'BoundTransfer',c(T+'TransferDetails',u(incoming?user:reserve),u(incoming?reserve:user),u(mint),key(base?1:2),c(F+(incoming?'ToCustody':'ToActor')),w(amount),c(F+(incoming?'Actor':'Custody'))),
    incoming?c(T+'Any'):c(T+'Exact',key(base?4:5)),incoming?c(T+'Exact',key(base?4:5)):c(T+'Any'),c('False'));
}
const mint=(n:bigint)=>c(T+'Mint',u(10),u(11),key(3),c(F+'ToActor'),w(n),c('False'));
const burn=(n:bigint)=>c(T+'Burn',u(10),u(11),key(3),w(n));
const accept=(x:bigint,y:bigint,l:bigint,effects:any[])=>c('Accepted',c('Open',pool(x,y,l)),c(T+'Effects',...effects));
const deposit=()=>accept(11000n,11000n,11000n,[transfer(true,true,1000n),transfer(false,true,1000n),mint(1000n)]);
const withdrawal=()=>accept(9000n,9000n,9000n,[burn(1000n),transfer(true,false,1000n),transfer(false,false,1000n)]);
const swap=()=>accept(11000n,9094n,10000n,[transfer(true,true,1000n),transfer(false,false,906n),c(T+'None')]);
function plain(t:any):any {assert.equal(t.$,'Ctr');return t.k==='U32'?B.u32_from_term(t):{constructor:t.k,fields:t.x.map(plain)};}
const cases:[string,string,string,string,bigint,boolean,()=>any][]=[
  ['unsigned execution','Rejected{1}','dispatch(state, instruction)','Swap',1000n,false,()=>c('Rejected',u(1))],
  ['wrong LP mint','Token.Mint{10, 11, lp,','Token.Mint{10, 11, base,','Deposit',1000n,true,deposit],
  ['withdraw credits reserve','Math.sub(x, dx)','Math.add(x, dx)','Withdraw',1000n,true,withdrawal],
  ['locked liquidity removed','Math.sub(supply, locked())','Math.Ok{supply}','Withdraw',9500n,true,()=>c('Rejected',u(6))],
  ['swap omits input credit','Math.add(x, gross)','Math.add(x, Math.zero())','Swap',1000n,true,swap],
  ['wrong swap recipient','Token.TransferDetails{8, 7, 9, quote, Fx.ToActor{}','Token.TransferDetails{8, 7, 9, quote, Fx.ToCustody{}','Swap',1000n,true,swap],
  ['deposit issues zero shares','funding(config, dx, dy, shares, False{})','funding(config, dx, dy, Math.zero(), False{})','Deposit',1000n,true,deposit],
  ['deposit underfunds recorded reserve','funding(config, dx, dy, shares, False{})','funding(config, Math.zero(), dy, shares, False{})','Deposit',1000n,true,deposit],
  ['deposit fails to account issued shares','Math.add(supply, shares)','Math.add(supply, Math.zero())','Deposit',1000n,true,deposit],
  ['reserve address unbound','Token.TransferDetails{4, 5, 6, base, Fx.ToCustody{}, amount, Fx.Actor{}}, Token.Any{}, Token.Exact{vault}, fresh','Token.TransferDetails{4, 5, 6, base, Fx.ToCustody{}, amount, Fx.Actor{}}, Token.Any{}, Token.Any{}, fresh','Deposit',1000n,true,deposit],
];
const mutations=[];
for(const [name,before,after,operation,amount,signed,expected] of cases) {
  const directory=fs.mkdtempSync('examples/.amm-refinement-negative-');
  try {
    assert.equal(source.split(before).length,2,name);
    fs.copyFileSync('examples/amm/pricing.bend',`${directory}/pricing.bend`);
    const path=`${directory}/amm.bend`;fs.writeFileSync(path,source.replace(before,after));
    const report=await check(path,`build/amm-negative-${mutations.length}`,1);
    assert.equal(report.claims.find((c:any)=>c.claim===`amm-Open-${operation==='Swap'?'SwapBase':operation}`).result,'sat');
    const context=c(S+'Context',key(6),c(signed?'True':'False'),w(0n));
    const instruction=operation==='Swap'?c('Swap',c('True'),w(amount),w(0n)):
      c(operation,w(amount),w(operation==='Deposit'?1000n:0n),w(operation==='Deposit'?1000n:0n));
    const book=await checkedBook(path);
    const call=[context,c('Open',pool(10000n,10000n,10000n)),instruction].reduce((f,x)=>B.App(f,x),B.Ref('process'));
    const actual=plain(B.term_snf(book,call)),mathematical=plain(expected());
    assert.notDeepEqual(actual,mathematical,name);
    mutations.push({name,report,concreteWitness:{operation,amount:amount.toString(),signed,base:'10000',quote:'10000',supply:'10000',actual,expected:mathematical}});
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
}
for(const name of ['pricing.deposit','pricing.withdraw','pricing.swap','../../sdk/sqrt.geometric_mean']) {
  const corrupted=JSON.parse(fs.readFileSync('build/amm-refinement.model.json','utf8'));
  corrupted.functions[name].body=null;
  const path='build/amm-negative-binding.model.json';fs.writeFileSync(path,JSON.stringify(corrupted));
  const result=invoke(path);assert.notEqual(result.status,0);assert.match(result.stderr,/Imported definition mismatch/);
}
const extended=JSON.parse(fs.readFileSync('build/amm-refinement.model.json','utf8'));
const instruction=extended.schema.types.find((t:any)=>t.name==='Instruction');
instruction.variants.push({name:'Uncovered',tag:4,fields:[],cMaker:'uncovered'});
fs.writeFileSync('build/amm-negative-schema.model.json',JSON.stringify(extended));
const uncovered=invoke('build/amm-negative-schema.model.json');
assert.notEqual(uncovered.status,0);assert.match(uncovered.stderr,/Protocol schema mismatch: Instruction/);
const files=['examples/amm/amm.bend','examples/amm/pricing.bend','sdk/math.bend','sdk/wide.bend','sdk/sqrt.bend','sdk/context.bend','sdk/effects.bend','sdk/issuance.bend',
  'compiler/backend.ts', 'compiler/tagged-sum-ir.ts','compiler/primitives.ts','compiler/schema.ts','package.json','package-lock.json',
  ...fs.readdirSync('verification').filter(f=>/\.(py|ts)$/.test(f)).map(f=>`verification/${f}`)];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/amm-refinement.json',JSON.stringify({bendCommit:BEND_COMMIT,positive,mutations,importMismatchesRejected:true,uncoveredInstructionRejected:true,hashes},null,2)+'\n');
console.log('AMM transition refinement: 32 obligations, ten SAT mutations with concrete Bend witnesses and four import negatives passed');
