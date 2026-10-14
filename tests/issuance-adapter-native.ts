import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {checkedProgram} from '../compiler/backend.ts';
import {evaluateCall} from '../verification/reference.ts';
import {digest,inventory} from '../verification/check-acyclic-lowering.ts';
const receipt=JSON.parse(fs.readFileSync('build/issuance-adapter/fresh-receipt.json','utf8'));
assert.equal(receipt.passed,true);assert.equal(receipt.endToEndVerified,false);
const inputBytes=fs.readFileSync(receipt.inputArtifact);assert.equal(digest(inputBytes),receipt.inputSha256);
const base=JSON.parse(inputBytes.toString());
const controlBytes=fs.readFileSync(receipt.reportArtifact);assert.equal(digest(controlBytes),receipt.reportSha256);
const report=JSON.parse(controlBytes.toString());assert.equal(report.passed,true);assert.equal(report.inputSha256,digest(inputBytes));
assert.deepEqual(inventory(),receipt.sourceHashes,'stale source binding');
const directory=receipt.inputArtifact.slice(0,-'/input.json'.length);
const recipes=[['mint-amount','(a2).as.c0.f1, (a2).as.c0.f4)','(a2).as.c0.f3, (a2).as.c0.f4)'],['counter-increment','bend_U32_2e_add((a1).as.c0.f0, 1u)','bend_U32_2e_add((a1).as.c0.f0, 2u)']];
assert.equal(report.mutations.length,recipes.length);
const mutations={semanticCounterexamples:report.mutations.map((mutation:any,i:number)=>{
 const [name,old,replacement]=recipes[i];assert.equal(mutation.name,name);
 const found=[...mutation.proof.stateClaims,...mutation.proof.effectClaims].filter((r:any)=>r.result==='sat');assert.equal(found.length,1);
 const witness={...found[0],function:'process'};assert.ok(witness.wireArgs);
 const program=structuredClone(base.program);assert.equal(program.artifact.c.split(old).length,2);program.artifact.c=program.artifact.c.replace(old,replacement);assert.equal(digest(program.artifact.c),mutation.cSha256);
 return {program,mutation:name,witness};
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
 const original=base.program;
 const exits:Record<string,number|null>={};
 for(const [label,c] of [['baseline',original.artifact.c],['mutant',program.artifact.c]]) {
  const path=`${directory}/composed-replay-${index}-${label}.c`,exe=path+'.out';
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
assert.deepEqual(inventory(),base.sourceHashes,'source changed during replay');
assert.deepEqual(fs.readFileSync(receipt.inputArtifact),inputBytes,'input changed during replay');
fs.writeFileSync(`${directory}/composed-replay-report.json`,JSON.stringify({passed:true,inputSha256:digest(inputBytes),controlsSha256:digest(controlBytes),checkerSha256:digest(fs.readFileSync(import.meta.path)),rows},null,2)+'\n');
console.log('Both composed issuance SMT counterexamples replayed against pinned Bend evaluation and native C with ASan/UBSan');
