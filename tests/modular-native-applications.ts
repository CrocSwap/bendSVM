import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {checkedProgram} from '../compiler/backend.ts';
import {evaluateCall} from '../verification/reference.ts';
import {digest,inventory} from '../verification/check-acyclic-lowering.ts';
const receipt=JSON.parse(fs.readFileSync('build/modular-lowering/fresh-receipt.json','utf8'));
const inputBytes=fs.readFileSync(receipt.inputArtifact);assert.equal(digest(inputBytes),receipt.inputSha256);assert.deepEqual(inventory(),receipt.sourceHashes);
const bytes=fs.readFileSync(receipt.reportArtifact);assert.equal(digest(bytes),receipt.reportSha256);const report=JSON.parse(bytes.toString()),base=JSON.parse(inputBytes.toString());
const directory=receipt.reportArtifact.slice(0,-'/child.json'.length);
const recipes=[['return bend_Rejected_make(1u);','return a1;'],['_ToOwner_make((a0).as.c0.f0)','_ToOwner_make((a0).as.c0.f1)']];
assert.deepEqual(report.mutations.slice(4).map((m:any)=>m.name),['vault-authorization','vesting-beneficiary']);
const mutations={semanticCounterexamples:report.mutations.slice(4).map((m:any,i:number)=>{
 const program=structuredClone(base.programs[m.programIndex]),[old,replacement]=recipes[i];assert.equal(program.artifact.c.split(old).length,2);
 program.artifact.c=program.artifact.c.replace(old,replacement);assert.equal(digest(program.artifact.c),m.cSha256);
 return {program,mutation:m.name,witness:m.proof.claims.at(-1)};
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
 const exits:Record<string,number|null>={};
 for(const [label,c] of [['baseline',original.artifact.c],['mutant',program.artifact.c]]) {
  const path=`${directory}/application-replay-${index}-${label}.c`,exe=path+'.out';
  const call=`${signature.cName}(${args.map((v:any,i:number)=>toC(signature.args[i],v)).join(', ')})`;
  fs.writeFileSync(path,c+`\nint main(void) { ${types.get(signature.result).cType} result = ${call}; return (${equal(signature.result,expected,'result')}) ? 0 : 42; }\n`);
  const compiled=spawnSync(process.env.CC??'clang',['-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all',path,'-o',exe],{encoding:'utf8',timeout:30000});
  assert.ifError(compiled.error);assert.equal(compiled.status,0,compiled.stderr);
  const executed=spawnSync(exe,[],{encoding:'utf8',timeout:5000});assert.ifError(executed.error);
  exits[label]=executed.status;
 }
 assert.deepEqual(exits,{baseline:0,mutant:42});
 rows.push({mutation:mutation.mutation,function:name,args,expected,exits});
}
assert.deepEqual(inventory(),receipt.sourceHashes,'source changed during replay');
assert.deepEqual(fs.readFileSync(receipt.inputArtifact),inputBytes,'input changed during replay');
fs.writeFileSync(`${directory}/native-applications.json`,JSON.stringify({passed:true,rows},null,2)+'\n');
console.log('Both application counterexamples replayed against pinned Bend evaluation and actual native C');
