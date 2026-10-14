import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {checkedProgram} from '../compiler/backend.ts';
import {evaluateCall} from '../verification/reference.ts';
import {digest,inventory} from '../verification/check-acyclic-lowering.ts';
import {mutations as recipes} from '../verification/check-vault-c.ts';
const directory='build/vault-c-replay';
fs.mkdirSync(directory,{recursive:true});
const receiptBytes=fs.readFileSync('build/vault-c-refinement.json'),receipt=JSON.parse(receiptBytes.toString());
const inputBytes=fs.readFileSync(receipt.inputArtifact);assert.equal(digest(inputBytes),receipt.inputSha256);
assert.deepEqual(inventory(),receipt.sourceHashes,'stale source binding');
const base={programs:[JSON.parse(inputBytes.toString()).program]};
const mutations={semanticCounterexamples:receipt.mutations.map((m:any,i:number)=>{
 const program=structuredClone(base.programs[0]);const [,target,replacement]=recipes[i];
 assert.ok(program.artifact.c.includes(target));program.artifact.c=program.artifact.c.replace(target,replacement);
 assert.equal(digest(program.artifact.c),m.cSha256);
 return {program,mutation:m.name,witness:{function:'process',wireArgs:m.wireArgs}};
})};
const rows=[];
for(const [index,mutation] of mutations.semanticCounterexamples.entries()) {
 const program=mutation.program;
 const schema=program.source.schema, types=new Map<string,any>(schema.types.map((t:any)=>[t.name,t]));
 const name=mutation.witness.function;
 const signature=schema.exports.find((f:any)=>f.name===name);
 const args=mutation.witness.wireArgs;
 const source=await checkedProgram(program.source.source);
 const expected=evaluateCall(source.book,schema,name,args);
 function toC(type:string,value:any):string {
  const t=types.get(type);
  if(t.kind==='u32')return `${value}u`;
  if(t.kind==='bool')return value?'1u':'0u';
  const v=t.variants.find((v:any)=>v.name===value.constructor);assert.ok(v);
  return `${v.cMaker}(${v.fields.map((f:any)=>toC(f.type,value.fields[f.name])).join(', ')})`;
 }
 function equal(type:string,value:any,expr:string):string {
  const t=types.get(type);
  if(t.kind!=='adt')return `((${expr}) == ${toC(type,value)})`;
  const v=t.variants.find((v:any)=>v.name===value.constructor);assert.ok(v);
  return [`((${expr}).tag == ${v.tag}u)`,...v.fields.map((f:any,i:number)=>equal(f.type,value.fields[f.name],`(${expr}).as.c${v.tag}.f${i}`))].join(' && ');
 }
 const original=base.programs.find((p:any)=>p.source.source===program.source.source);
 const exits:Record<string,number|null>={},tags:Record<string,number>={};
 for(const [label,c] of [['baseline',original.artifact.c],['mutant',program.artifact.c]]) {
  const path=`${directory}/replay-${index}-${label}.c`,exe=path+'.out';
  const call=`${signature.cName}(${args.map((v:any,i:number)=>toC(signature.args[i],v)).join(', ')})`;
  fs.writeFileSync(path,c+`\n#include <stdio.h>\nint main(void) { ${types.get(signature.result).cType} result = ${call}; printf("%u\\n", result.tag); return (${equal(signature.result,expected,'result')}) ? 0 : 42; }\n`);
  const compiled=spawnSync(process.env.CC??'clang',['-std=c11','-O1',path,'-o',exe],{encoding:'utf8',timeout:30000});
  assert.ifError(compiled.error);assert.equal(compiled.status,0,compiled.stderr);
  const executed=spawnSync(exe,[],{encoding:'utf8',timeout:5000});assert.ifError(executed.error);
  exits[label]=executed.status;tags[label]=Number(executed.stdout.trim());
 }
 assert.deepEqual(exits,{baseline:0,mutant:42});
 const accepted=schema.types.find((t:any)=>t.name==='Outcome').variants.find((v:any)=>v.name==='Accepted').tag;
 if(index===0) {
  assert.equal(args[0].fields.signed,false);assert.equal(tags.mutant,accepted,'mutant must actually accept unsigned input');
  assert.equal(expected.constructor,'Rejected');
 } else {
  assert.equal(args[2].constructor,'Deposit');assert.ok(args[2].fields.amount.fields.lo || args[2].fields.amount.fields.hi);
  assert.equal(expected.constructor,'Accepted');
 }
 rows.push({mutation:mutation.mutation,function:name,args,expected,exits,tags});
}
assert.deepEqual(inventory(),receipt.sourceHashes,'source changed during replay');
assert.deepEqual(fs.readFileSync(receipt.inputArtifact),inputBytes,'input changed during replay');
fs.writeFileSync(`${directory}/replay-report.json`,JSON.stringify({passed:true,rows,invariantReceiptSha256:digest(receiptBytes)},null,2)+'\n');
console.log('All three full-vault faults replayed; unsigned input actually accepted by mutant, positive deposits exercised');
