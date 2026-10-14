import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {checkedProgram} from '../compiler/backend.ts';
import {evaluateCall} from '../verification/reference.ts';
import {digest} from '../verification/check-acyclic-lowering.ts';
const receipt=JSON.parse(fs.readFileSync('build/ranked-lowering/fresh-receipt.json','utf8'));
const dir=receipt.inputArtifact.slice(0,-'/input.json'.length),raw=fs.readFileSync(receipt.inputArtifact),data=JSON.parse(raw.toString()),program=data.programs.find((p:any)=>p.source.source==='examples/queue/PROOF.bend');
assert.equal(receipt.passed,true);assert.equal(digest(raw),receipt.inputSha256);assert.equal(digest(fs.readFileSync(receipt.reportArtifact)),receipt.reportSha256);
for(const [p,h] of Object.entries(program.sourceHashes))assert.equal(digest(fs.readFileSync(p)),h);
const source=await checkedProgram(program.source.source),schema=program.source.schema,types=new Map<string,any>(schema.types.map((t:any)=>[t.name,t])),signature=schema.exports.find((e:any)=>e.name==='queue.select');
const c=(type:string,tag:number,...values:any[])=>{const v=types.get(type).variants[tag];assert.equal(values.length,v.fields.length);return {constructor:v.name,fields:Object.fromEntries(v.fields.map((f:any,i:number)=>[f.name,values[i]]))};};
const field=(type:string,i:number)=>types.get(type).variants[0].fields[i].type;
const [ctx,st,ix,meta]=signature.args,keyType=field(ctx,0),wordType=field(ctx,2);
const key=(n:number)=>c(keyType,0,...Array(8).fill(n)),word=(n:number)=>c(wordType,0,n,0);
const resultType=types.get(signature.result),rangeType=resultType.variants[1].fields[0].type;
const cases:any[]=[];
for(const stateTag of [0,1,2,3])for(const [length,capacity,cursor] of [[0,0,0],[0,2,0],[1,2,0],[2,2,1],[2,3,2],[3,2,0],[2,2,3],[0xffffffff,0xffffffff,0xfffffffe],[0,0xffffffff,0xffffffff]])for(const instruction of [0,1,2,3])for(const page of (instruction===3?[0,1,2,3,0xffffffff]:[0])){
 const queue=c('queue.Queue',0,key(1),key(2),key(3),key(4),length,cursor,word(20));
 const state=c(st,stateTag,...([1,2].includes(stateTag)?[queue]:[]));
 const ins=instruction===0?c(ix,0,key(2),key(3)):instruction===1?c(ix,1,key(5),word(10)):instruction===2?c(ix,2):c(ix,3,page,2);
 const args=[c(ctx,0,key(1),true,word(100),key(4)),state,ins,c(meta,0,length,capacity)];
 const start=instruction===1?length:instruction===3&&stateTag===2?cursor:0;
 const count=instruction===1?1:instruction===3?page:0;
 // JavaScript integers are exact for this sum of two u32 values; no wrapping.
 const valid=length<=capacity&&count<=2&&start+count<=(instruction===1?capacity:length);
 const expected=valid?c(signature.result,1,c(rangeType,0,start,count)):c(signature.result,0);
 const result=evaluateCall(source.book,schema,'queue.select',args);assert.deepEqual(result,expected,JSON.stringify({stateTag,length,capacity,cursor,instruction,page}));
 cases.push({args,result});
}
function toC(type:string,value:any):string {const t=types.get(type);assert.ok(t);if(t.kind==='u32'){assert.ok(Number.isInteger(value)&&value>=0&&value<=0xffffffff);return `${value}u`;}if(t.kind==='bool'){assert.equal(typeof value,'boolean');return value?'1u':'0u';}const v=t.variants.find((v:any)=>v.name===value.constructor);assert.ok(v);return `${v.cMaker}(${v.fields.map((f:any)=>toC(f.type,value.fields[f.name])).join(',')})`;}
function equal(type:string,value:any,e:string):string {const t=types.get(type);if(t.kind!=='adt')return `((${e})==${toC(type,value)})`;const v=t.variants.find((v:any)=>v.name===value.constructor);assert.ok(v);return [`((${e}).tag==${v.tag}u)`,...v.fields.map((f:any,i:number)=>equal(f.type,value.fields[f.name],`(${e}).as.c${v.tag}.f${i}`))].join(' && ');}

const checks=cases.map(({args,result})=>`{ ${types.get(signature.result).cType} r=${signature.cName}(${args.map((v:any,i:number)=>toC(signature.args[i],v)).join(',')}); if(!(${equal(signature.result,result,'r')}))return 42; }`).join('\n');
const rows=[];
for(const label of ['baseline','selection-wrong-cursor','selection-wrap-range','selection-wrong-page']){
 const body=label==='baseline'?program.artifact.c:fs.readFileSync(`${dir}/${label}.c`,'utf8'),file=`${dir}/selector-native-${label}.c`,exe=file+'.out';
 fs.writeFileSync(file,body+`\nint main(void){${checks}\nreturn 0;}\n`);
 const compile=spawnSync(process.env.CC??'clang',['-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all',file,'-o',exe],{encoding:'utf8',timeout:60000});
 fs.writeFileSync(file+'.compile.log',(compile.stdout??'')+(compile.stderr??''));assert.ifError(compile.error);assert.equal(compile.status,0,compile.stderr);
 const run=spawnSync(exe,[],{encoding:'utf8',timeout:10000});fs.writeFileSync(file+'.run.log',(run.stdout??'')+(run.stderr??''));assert.ifError(run.error);assert.equal(run.signal,null);assert.equal(run.status,label==='baseline'?0:42,label);assert.equal(run.stderr,'');
 rows.push({label,exitCode:run.status,files:Object.fromEntries([file,exe,file+'.compile.log',file+'.run.log'].map(p=>[p,digest(fs.readFileSync(p))]))});
}
for(const [p,h] of Object.entries(program.sourceHashes))assert.equal(digest(fs.readFileSync(p)),h);
assert.deepEqual(fs.readFileSync(`${dir}/input.json`),raw);
fs.writeFileSync(`${dir}/queue-selector-native.json`,JSON.stringify({passed:true,endToEndVerified:false,inputSha256:digest(raw),reportSha256:receipt.reportSha256,checkerSha256:digest(fs.readFileSync(import.meta.path)),cases:cases.length,expected:cases,replays:rows,scope:'Checked Bend versus native emitted C with ASan/UBSan; independent mathematical range oracle. No adapter/SBF theorem.'},null,2)+'\n');
console.log(cases.length+' queue cases and three native fault replays passed');
