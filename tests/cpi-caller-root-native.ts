import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {checkedProgram} from '../compiler/backend.ts';
import {evaluateCall} from '../verification/reference.ts';
import {createHash} from 'node:crypto';
const digest=(v:any)=>createHash('sha256').update(v).digest('hex');
const [inputPath, controlPath, directory]=process.argv.slice(2);
assert(inputPath && controlPath && directory);fs.mkdirSync(directory,{recursive:true});
const inputBytes=fs.readFileSync(inputPath), controlBytes=fs.readFileSync(controlPath);
const base=JSON.parse(inputBytes.toString()),controls=JSON.parse(controlBytes.toString());
assert.equal(controls.passed,true);assert.equal(controls.controls.length,6);
const inputs:Record<string,string>={};
for(const f of base.fixtures)for(const [p,h] of Object.entries(f.sourceDependencies)){assert.equal(digest(fs.readFileSync(p)),h);inputs[p]=h as string;}
const mutations={semanticCounterexamples:controls.controls.map((m:any)=>{
 const original=base.fixtures.find((f:any)=>f.name===m.fixture);assert.ok(original);
 const program=structuredClone(original.program);program.artifact.c=fs.readFileSync(m.mutatedHeader,'utf8');
 assert.equal(digest(program.artifact.c),m.sha256);
 return {program,mutation:`${m.fixture}:${m.case}`,witness:m.claim};
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
 const original=base.fixtures.map((f:any)=>f.program).find((p:any)=>p.source.source===program.source.source);
 const exits:Record<string,number|null>={};
 for(const [label,c] of [['baseline',original.artifact.c],['mutant',program.artifact.c]]) {
  const path=`${directory}/replay-${index}-${label}.c`,exe=path+'.out';
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
for(const [p,h] of Object.entries(inputs))assert.equal(digest(fs.readFileSync(p)),h,'source drift');
assert.deepEqual(fs.readFileSync(inputPath),inputBytes);assert.deepEqual(fs.readFileSync(controlPath),controlBytes);
for(const p of [inputPath,controlPath,import.meta.path,'compiler/backend.ts','verification/reference.ts'])inputs[p]=digest(fs.readFileSync(p));
fs.writeFileSync(`${directory}/native-replay-report.json`,JSON.stringify({passed:true,scope:'Six pure-root counterexamples: pinned Bend evaluation versus actual baseline and mutated C under ASan/UBSan. No account adapter, external CPI or SBF execution claim.',inputs,rows},null,2)+'\n');
console.log('Six CPI root counterexamples replayed against pinned Bend and native C under ASan/UBSan');
