import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {model} from './model.ts';
import {checkedBook} from '../compiler/backend.ts';
import {evaluateCall} from './reference.ts';
import {wireCodec,type WireValue} from '../sdk/wire.ts';
import {prepareBend,BEND_COMMIT} from '../scripts/build.ts';
prepareBend();
fs.rmSync('build/queue-refinement.json',{force:true});
await import('./check.ts');
fs.copyFileSync('build/math-refinement.model.json','build/queue-arithmetic.model.json');
fs.copyFileSync('build/math-refinement.json','build/queue-arithmetic-refinement.json');
const source='examples/queue/queue.bend';
async function prove(file:string,stem:string,expected:number) {
  const program=await model(file,['process','select']);
  fs.writeFileSync(stem+'.model.json',JSON.stringify(program)+'\n');
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/queue.py',stem+'.model.json',...(expected===1?['counterexample']:[])],{stdio:['ignore','pipe','inherit'],encoding:'utf8',maxBuffer:32*1024*1024});
  assert.equal(result.status,expected,result.stdout);
  const report=JSON.parse(result.stdout);assert(report.claims.every((c:any)=>['sat','unsat'].includes(c.result)));
  if(expected===0){assert.equal(report.claims.length,428);assert(report.claims.every((c:any)=>c.result==='unsat'));}
  else assert(report.claims.some((c:any)=>c.result==='sat'));
  return {program,report};
}
const positive=await prove(source,'build/queue-refinement',0);
const schema=positive.program.schema,codec=wireCodec(schema),fn=schema.exports.find(f=>f.name==='process')!;
const construct=(t:string,tag:number,values:WireValue[]):WireValue=>{
  const type=schema.types.find(x=>x.name===t)!;assert(type.kind==='adt');const v=type.variants[tag];assert.equal(v.fields.length,values.length);
  return {constructor:v.name,fields:Object.fromEntries(v.fields.map((f,i)=>[f.name,values[i]]))};
};
const field=(t:string,i:number,tag=0)=>{const type=schema.types.find(x=>x.name===t)!;assert(type.kind==='adt');return type.variants[tag].fields[i].type;};
const [ctx,st,ix,meta,win]=fn.args,qt=field(st,0,1),kt=field(ctx,0),wt=field(ctx,2),vt=field(win,1),store=field(vt,1),item=field(store,0);
const key=(n:number)=>construct(kt,0,[n,0,0,0,0,0,0,0]);
const word=(n:number)=>construct(wt,0,[n,0]);
function fixture(append:boolean,actor=1,collection=4,remaining=35):WireValue[] {
  const count=append?0:2;
  return [construct(ctx,0,[key(actor),true,word(7),key(collection)]),
    construct(st,append?1:2,[construct(qt,0,[key(1),key(2),key(3),key(4),count,0,word(append?0:remaining)])]),
    append?construct(ix,1,[key(5),word(17)]):construct(ix,3,[2,2]),
    construct(meta,0,[count,256]),construct(win,0,[0,construct(vt,0,[count,construct(store,0,[construct(item,0,[key(5),word(17)]),construct(item,0,[key(6),word(18)])])])])];
}
const original=await checkedBook(source),text=fs.readFileSync(source,'utf8'),mutations=[];
for(const [name,before,after,args] of [
  ['missing owner','Sol.equal(actor, owner)','True{}',fixture(false,99)],
  ['missing collection binding','Sol.equal(actual, collection)','True{}',fixture(false,1,99)],
  ['wrong recipient','Token.ToOwner{recipient}','Token.ToOwner{vault}',fixture(false)],
  ['wrong destination order','U32.add(7, index)','U32.add(8, index)',fixture(false)],
  ['lost cursor progress','+next = U32.add(cursor, page)','+next = cursor',fixture(false)],
  ['missing conservation rejection','      Rejected{6}','      Accepted{state, window, length, effects}',fixture(false,1,4,36)],
  ['wrong funding amount','Token.ToCustody{}, amount, Token.Actor{}','Token.ToCustody{}, M.zero(), Token.Actor{}',fixture(true)],
] as const) {
  const dir=fs.mkdtempSync('build/queue-refinement-negative-');
  try {
    assert(text.includes(before));const file=dir+'/queue.bend';fs.writeFileSync(file,text.replace(before,after));
    const result=await prove(file,dir+'/proof',1);
    const mutated=await checkedBook(file);
    const originalValue=evaluateCall(original,schema,'process',[...args]),mutatedValue=evaluateCall(mutated,schema,'process',[...args]);
    assert.notDeepEqual(codec.encode(fn.result,originalValue),codec.encode(fn.result,mutatedValue),name+' concrete replay');
    mutations.push({name,...result.report,replay:{args,original:originalValue,mutated:mutatedValue}});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
const bindingNegatives=[];
for(const name of [...new Set<string>(positive.report.arithmeticBindings.flatMap((b:any)=>b.functions))]) {
  const corrupted=structuredClone(positive.program);corrupted.functions[name].body={$:'InvalidBindingMutation'} as any;
  const file='build/queue-negative-binding.model.json';fs.writeFileSync(file,JSON.stringify(corrupted));
  const r=spawnSync(process.env.PYTHON??'python3',['-B','verification/queue.py',file],{encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/Imported definition mismatch/);bindingNegatives.push(name);
}
for(const name of [...new Set<string>(positive.report.arithmeticBindings.flatMap((b:any)=>b.types))]) {
  const corrupted=structuredClone(positive.program);corrupted.schema.types.find((t:any)=>t.name===name)!.name+='__changed';
  const file='build/queue-negative-binding.model.json';fs.writeFileSync(file,JSON.stringify(corrupted));
  const r=spawnSync(process.env.PYTHON??'python3',['-B','verification/queue.py',file],{encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/KeyError|Imported type mismatch/);bindingNegatives.push(name);
}
const schemaNegatives=[];
for(const name of ['State','Instruction','Outcome']) {
  const corrupted=structuredClone(positive.program);const t=corrupted.schema.types.find((t:any)=>t.name===name)!;
  assert(t.kind==='adt');t.variants.push({name:'Uncovered',tag:t.variants.length,fields:[],cMaker:'uncovered'});
  const file='build/queue-negative-binding.model.json';fs.writeFileSync(file,JSON.stringify(corrupted));
  const r=spawnSync(process.env.PYTHON??'python3',['-B','verification/queue.py',file],{encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/Protocol schema mismatch/);schemaNegatives.push(name);
}
fs.rmSync('build/queue-negative-binding.model.json',{force:true});
const files=[source,'sdk/math.bend','sdk/context.bend','sdk/collection.bend','sdk/buffer.bend','sdk/fold.bend','sdk/iteration.bend','sdk/effects.bend','sdk/issuance.bend',
  'verification/model.ts','verification/prove.py','verification/binding.py','verification/check.ts','verification/reference.ts','verification/queue.py','verification/check-queue.ts',
  'compiler/backend.ts','compiler/primitives.ts','compiler/schema.ts','compiler/diagnostics.ts','build/queue-arithmetic.model.json','build/queue-arithmetic-refinement.json'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/queue-refinement.json',JSON.stringify({bendCommit:BEND_COMMIT,positive:positive.report,mutations,bindingNegatives,schemaNegatives,hashes},null,2)+'\n');
console.log('Queue refinement: 428 claims, seven mutation counterexamples with Bend replays, and arithmetic binding negatives passed');
