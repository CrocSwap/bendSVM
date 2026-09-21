import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { model } from './model.ts';
import { checkedBook } from '../compiler/backend.ts';
import { evaluateCall } from './reference.ts';
import { wireCodec, type WireValue } from '../sdk/wire.ts';
import { prepareBend, BEND_COMMIT } from '../scripts/build.ts';

prepareBend();
fs.mkdirSync('build',{recursive:true});
fs.rmSync('build/batch-refinement.json',{force:true});
// Reprove the exact arithmetic closure before using its compositional summary.
await import('./check.ts');
fs.copyFileSync('build/math-refinement.json','build/batch-arithmetic-refinement.json');
fs.copyFileSync('build/math-refinement.model.json','build/batch-arithmetic.model.json');
const source='examples/batch/batch.bend';
const sourceText=fs.readFileSync(source,'utf8');
async function prove(file:string,stem:string,expected:number) {
  const program=await model(file,['process','sum']);
  fs.writeFileSync(stem+'.model.json',JSON.stringify(program)+'\n');
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/batch.py',stem+'.model.json',...(expected===1?['counterexample']:[])],{encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:16*1024*1024});
  assert.equal(result.status,expected,result.stderr||result.stdout);
  const report=JSON.parse(result.stdout);
  assert(report.claims.every((c:any)=>c.result==='sat'||c.result==='unsat'),'Unknown/timeout is not proof evidence');
  if(expected===0){assert.equal(report.claims.length,788);assert(report.claims.every((c:any)=>c.result==='unsat'));}
  else assert(report.claims.some((c:any)=>c.result==='sat'));
  return {program,report};
}
const positive=await prove(source,'build/batch-refinement',0);
// A compositional summary is usable only for the exact proved implementation,
// including its transitive helpers and runtime types.
assert.equal(positive.report.arithmeticBinding.result,'checked');
const bindingNegatives:string[]=[];
for(const name of positive.report.arithmeticBinding.functions as string[]) {
  const corrupted=structuredClone(positive.program);
  corrupted.functions[name].body={ $:'InvalidBindingMutation' } as any;
  const file='build/batch-negative-binding.model.json';
  fs.writeFileSync(file,JSON.stringify(corrupted));
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/batch.py',file],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Imported definition mismatch/);
  bindingNegatives.push(name);
}
for(const name of positive.report.arithmeticBinding.types as string[]) {
  const corrupted=structuredClone(positive.program);
  const type=corrupted.schema.types.find((t:any)=>t.name===name)!;
  (type as any).name+='__changed';
  const file='build/batch-negative-binding.model.json';
  fs.writeFileSync(file,JSON.stringify(corrupted));
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/batch.py',file],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/KeyError|Imported type mismatch/);
  bindingNegatives.push(name);
}
fs.rmSync('build/batch-negative-binding.model.json',{force:true});
for(const name of ['State','Instruction','Outcome']) {
  const corrupted=structuredClone(positive.program);
  const type=corrupted.schema.types.find((t:any)=>t.name===name)! as any;
  type.variants.push({name:'Uncovered',tag:type.variants.length,fields:[],cMaker:'uncovered'});
  const file='build/batch-negative-schema.model.json';
  fs.writeFileSync(file,JSON.stringify(corrupted));
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/batch.py',file],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Protocol schema mismatch/);
}
fs.rmSync('build/batch-negative-schema.model.json',{force:true});
const schema=positive.program.schema,codec=wireCodec(schema),fn=schema.exports.find(f=>f.name==='process')!;
// Fixed replay fixtures are constructed independently of the SMT model. Every
// negative needs both a symbolic counterexample and an actual Bend mismatch.
const ct=(suffix:string,...values:WireValue[]):WireValue=>{
  const variants=schema.types.flatMap(t=>t.kind==='adt'?t.variants:[]);
  const v=variants.find(v=>v.name===suffix||v.name.endsWith(suffix))!;assert(v,`Missing ${suffix}`);
  return {constructor:v.name,fields:Object.fromEntries(v.fields.map((f,i)=>[f.name,values[i]]))};
};
const key=(n:number)=>ct('context.Key',...Array(8).fill(n));
const word=(n:number)=>ct('math.U64',n,0);
const t=(name:string)=>{const type=schema.types.find(t=>t.name===name)!;assert(type.kind==='adt');return type;};
const state=t(fn.args[1]),batch=t(state.variants[1].fields[0].type),vec=t(batch.variants[0].fields[3].type);
const outer=t(vec.variants[0].fields[1].type),inner=t(outer.variants[0].fields[0].type);
const record=(type:ReturnType<typeof t>,...values:WireValue[])=>ct(type.variants[0].name,...values);
const obligations=record(vec,2,record(outer,record(inner,ct('Obligation',key(10),word(10)),ct('Obligation',key(11),word(20))),
  record(inner,ct('Obligation',key(12),word(30)),ct('Obligation',key(13),word(40)))));
const context=(actor:number,signed:boolean)=>ct('context.Context',key(actor),signed,word(100));
const funded=(total:number)=>ct('Funded',record(batch,key(1),key(2),key(3),obligations,2,word(total)));
const fixtures:WireValue[][]=[
  [context(1,true),ct('Empty'),ct('Initialize',key(2),key(3),obligations,2)],
  [context(1,false),ct('Empty'),ct('Initialize',key(2),key(3),obligations,2)],
  [context(1,true),funded(30),ct('Settle')],[context(2,true),funded(30),ct('Settle')],
  [context(1,false),funded(30),ct('Settle')],[context(1,true),funded(31),ct('Settle')],
];
const original=await checkedBook(source);
const expected=fixtures.map(args=>evaluateCall(original,schema,'process',args));
const mutations=[];
for(const [name,before,after] of [
  ['missing signature','Bool.and(signed, Sol.equal(actor, owner))','Sol.equal(actor, owner)'],
  ['missing owner check','Bool.and(signed, Sol.equal(actor, owner))','signed'],
  ['wrong recipient','Token.ToOwner{recipient}','Token.ToOwner{mint}'],
  ['wrong transfer amount','Token.ToOwner{recipient}, amount, Token.Custody{}','Token.ToOwner{recipient}, Math.U64{1, 0}, Token.Custody{}'],
  ['wrong destination order','U32.add(6, length)','U32.add(7, length)'],
  ['missing conservation check','Math.equal(value, expected)','True{}'],
  ['wrong total accumulation','overflow(Math.add(total, amount))','overflow(Math.add(total, Math.U64{1, 0}))'],
]) {
  const dir=fs.mkdtempSync('build/batch-refinement-negative-');
  try {
    assert(sourceText.includes(before));const file=`${dir}/batch.bend`;
    let changed=sourceText.replace(before,after);
    if(name==='wrong recipient')changed=changed.replace('def append(mint:','def append(+mint:');
    fs.writeFileSync(file,changed);
    const {report}=await prove(file,`${dir}/result`,1);
    const book=await checkedBook(file);let replay:any;
    for(let i=0;i<fixtures.length;i++){
      const actual=evaluateCall(book,schema,'process',fixtures[i]);
      if(Buffer.compare(codec.encode(fn.result,actual),codec.encode(fn.result,expected[i]))!==0){replay={input:fixtures[i],actual,expected:expected[i]};break;}
    }
    assert(replay,`Mutation requires concrete Bend replay: ${name}`);
    mutations.push({name,...report,replay});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
const files=['examples/batch/batch.bend','sdk/math.bend','sdk/context.bend','sdk/buffer.bend','sdk/fold.bend','sdk/iteration.bend','sdk/effects.bend','sdk/issuance.bend','sdk/effect-buffer.bend',
  'verification/model.ts','verification/prove.py','verification/binding.py','verification/batch.py','verification/check-batch.ts','verification/reference.ts','compiler/backend.ts','compiler/primitives.ts',
  'build/batch-arithmetic-refinement.json','build/batch-arithmetic.model.json'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/batch-refinement.json',JSON.stringify({bendCommit:BEND_COMMIT,positive:positive.report,mutations,bindingNegatives,uncoveredProtocolRejected:true,hashes},null,2)+'\n');
console.log('Batch refinement: 788 universal obligations passed; seven mutations have symbolic counterexamples and concrete Bend replays');
