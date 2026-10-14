import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {checkedProgram} from '../compiler/backend.ts';
import {evaluateCall} from '../verification/reference.ts';
import {digest,inventory} from '../verification/check-acyclic-lowering.ts';
const fresh=JSON.parse(fs.readFileSync('build/vault-adapter-bridge/fresh-receipt.json','utf8'));
const directory=fresh.input.slice(0,fresh.input.lastIndexOf('/'));
fs.mkdirSync(directory,{recursive:true});
const receiptBytes=fs.readFileSync(`${directory}/semantic-report.json`),receipt=JSON.parse(receiptBytes.toString());
const inputBytes=fs.readFileSync(`${directory}/input.json`);assert.equal(digest(inputBytes),receipt.inputSha256);
for(const [path,hash] of Object.entries(receipt.sourceHashes))assert.equal(digest(fs.readFileSync(path)),hash,'stale source '+path);
const input=JSON.parse(inputBytes.toString());const original=input.program;const rawWitness=receipt.transfer.planClaims.find((c:any)=>c.name==='deposit-plan-destination');
const base={programs:[original]};const program=structuredClone(original);
const target='_Transfer_make(4u, 5u, 6u, a1,';assert.ok(program.artifact.c.includes(target));
program.artifact.c=program.artifact.c.replace(target,'_Transfer_make(4u, 4u, 6u, a1,');
const mutations={semanticCounterexamples:[{program,mutation:'wrong destination in extracted transfer',witness:{function:'vault.process',wireArgs:rawWitness.wireArgs}}]};
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
  const path=`${directory}/effect-replay-${index}-${label}.c`,exe=path+'.out';
  const stateBytes=rawWitness.instructionBytes[0]===0?Array(76).fill(0):rawWitness.stateBytes.slice(20);
  const instructionBytes=rawWitness.instructionBytes.slice(1);
  const stateType=types.get(signature.args[1]),ixType=types.get(signature.args[2]);
  fs.writeFileSync(`${directory}/state-${label}.h`,c);
  fs.writeFileSync(`${directory}/state-${label}.wire.h`,input.fixture.files['vault.wire.h'].replace('#include \"vault.h\"',`#include \"state-${label}.h\"`));
  const decoded=`${stateType.cType} before; ${ixType.cType} instruction; unsigned char sb[76]={${stateBytes.join(',')}},ib[34]={${instructionBytes.join(',')}}; if(!bend_vault_2e_State_decode(sb,76,&before)||!(${equal(signature.args[1],args[1],'before')}))return 90; if(!bend_vault_2e_Instruction_decode(ib,34,&instruction)||!(${equal(signature.args[2],args[2],'instruction')}))return 91;`;
  const call=`${signature.cName}(${toC(signature.args[0],args[0])},before,instruction)`;
  const extractCheck=`BendTransfer slots[2]; if(result.tag!=0 || !bend_extract_effects(&result.as.c0.f1,slots))return 92; if(slots[0].active!=1 || slots[0].source!=4 || slots[0].destination!=${label==='mutant'?4:5} || slots[1].active!=0)return 93;`;
  const extraction=input.fixture.files[input.fixture.adapter].split('typedef struct { u64 slot;')[0].replace('#include "vault.wire.h"',`#include "state-${label}.wire.h"`);
  fs.writeFileSync(path,extraction+`\n#include <stdio.h>\nint main(void) { ${decoded} ${types.get(signature.result).cType} result = ${call}; printf("%u\\n", result.tag); ${extractCheck} return (${equal(signature.result,expected,'result')}) ? 0 : 42; }\n`);
  const compiled=spawnSync(process.env.CC??'clang',['-std=c11','-O1','-Iruntime','-fsanitize=undefined','-fno-sanitize-recover=all',path,'-o',exe],{encoding:'utf8',timeout:30000});
  assert.ifError(compiled.error);assert.equal(compiled.status,0,compiled.stderr);
  const executed=spawnSync(exe,[],{encoding:'utf8',timeout:5000});assert.ifError(executed.error);
  exits[label]=executed.status;tags[label]=Number(executed.stdout.trim());
 }
 assert.deepEqual(exits,{baseline:0,mutant:42});
 const accepted=schema.types.find((t:any)=>t.name==='vault.Outcome').variants.find((v:any)=>v.name==='vault.Accepted').tag;
 if(index===0) {
  assert.equal(args[0].fields.signed,true);assert.equal(tags.mutant,accepted,'mutant must accept the transfer witness');
  assert.equal(args[2].constructor,'vault.Deposit');
 }
 rows.push({mutation:mutation.mutation,function:name,args,expected,exits,tags});
}
for(const [path,hash] of Object.entries(receipt.sourceHashes))assert.equal(digest(fs.readFileSync(path)),hash,'source changed '+path);
assert.deepEqual(fs.readFileSync(`${directory}/input.json`),inputBytes,'input changed during replay');
fs.writeFileSync(`${directory}/effect-replay-report.json`,JSON.stringify({passed:true,rows,invariantReceiptSha256:digest(receiptBytes)},null,2)+'\n');
console.log('Native destination fault accepts the decoded deposit and extracts destination 4 instead of 5; baseline agrees with checked Bend');
