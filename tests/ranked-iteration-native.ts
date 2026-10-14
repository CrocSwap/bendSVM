import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {checkedProgram} from '../compiler/backend.ts';
import {evaluateCall} from '../verification/reference.ts';
import {digest,inventory} from '../verification/check-acyclic-lowering.ts';
const receipt=JSON.parse(fs.readFileSync('build/ranked-lowering/fresh-receipt.json','utf8'));
assert.equal(receipt.passed,true);
const directory=receipt.inputArtifact.slice(0,-'/input.json'.length),input=fs.readFileSync(receipt.inputArtifact),data=JSON.parse(input.toString()),program=data.programs[1];
assert.equal(digest(input),receipt.inputSha256);assert.equal(digest(fs.readFileSync(receipt.reportArtifact)),receipt.reportSha256);
assert.deepEqual(inventory(),data.sourceHashes);
const before=inventory();
const source=await checkedProgram(program.source.source),schema=program.source.schema,types=new Map<string,any>(schema.types.map((t:any)=>[t.name,t]));
const state=(left:number,right:number)=>({constructor:'State',fields:{left,right}});
const expected:any[]=[];
for(let fuel=0;fuel<=64;fuel++)for(const [left,right] of [[0,1],[0xffffffff,0x80000000],[17,17]]){
 for(const [name,args,result] of [
 ['count',[fuel,left],(left+fuel)>>>0],
 ['swaps',[fuel,state(left,right)],fuel%2?state(right,left):state(left,right)],
 ['rotate',[fuel,left,right],fuel%2?state(right,left):state(left,right)],
 ['toggle',[fuel,false],!!(fuel%2)],['toggle',[fuel,true],!(fuel%2)]
 ] as const){assert.deepEqual(evaluateCall(source.book,schema,name,args),result);expected.push({name,args,result});}
}
function toC(type:string,value:any):string {const t=types.get(type);assert.ok(t);if(t.kind==='u32'){assert.ok(Number.isInteger(value)&&value>=0&&value<=0xffffffff);return `${value}u`;}if(t.kind==='bool'){assert.equal(typeof value,'boolean');return value?'1u':'0u';}const v=t.variants.find((v:any)=>v.name===value.constructor);assert.ok(v);return `${v.cMaker}(${v.fields.map((f:any)=>toC(f.type,value.fields[f.name])).join(',')})`;}
function equal(type:string,value:any,e:string):string {const t=types.get(type);if(t.kind!=='adt')return `((${e})==${toC(type,value)})`;const v=t.variants.find((v:any)=>v.name===value.constructor);assert.ok(v);return [`((${e}).tag==${v.tag}u)`,...v.fields.map((f:any,i:number)=>equal(f.type,value.fields[f.name],`(${e}).as.c${v.tag}.f${i}`))].join(' && ');}

const faults=JSON.parse(fs.readFileSync(directory+'/iteration-faults.json','utf8'));assert.equal(faults.passed,true);assert.equal(faults.inputSha256,digest(input));
const variants=[{name:'baseline',c:program.artifact.c,wanted:0},...faults.faults.map((f:any)=>{const c=fs.readFileSync(directory+'/'+f.name+'.c','utf8');assert.equal(digest(c),f.cSha256);return {name:f.name,c,wanted:42};})];
const replays=[];
for(const {name,c,wanted} of variants){
 const path=directory+'/native-iteration-'+name+'.c',exe=path+'.out';
 const checks=expected.map(({name,args,result})=>{const sig=schema.exports.find((e:any)=>e.name===name);assert.ok(sig);return `{ ${types.get(sig.result).cType} r=${sig.cName}(${args.map((v:any,i:number)=>toC(sig.args[i],v)).join(',')}); if(!(${equal(sig.result,result,'r')}))return 42; }`;}).join('\n');
 fs.writeFileSync(path,c+'\nint main(void){\n'+checks+'\nreturn 0;}\n');
 const compiled=spawnSync(process.env.CC??'clang',['-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all',path,'-o',exe],{encoding:'utf8',timeout:60000});fs.writeFileSync(path+'.compile.log',(compiled.stdout??'')+(compiled.stderr??''));assert.ifError(compiled.error);assert.equal(compiled.status,0,compiled.stderr);
 const run=spawnSync(exe,[],{encoding:'utf8',timeout:10000});fs.writeFileSync(path+'.run.log',(run.stdout??'')+(run.stderr??''));assert.ifError(run.error);assert.equal(run.signal,null);assert.equal(run.status,wanted,name);assert.equal(run.stderr,'');
 replays.push({name,cSha256:digest(c),exitCode:run.status,files:Object.fromEntries([path,exe,path+'.compile.log',path+'.run.log'].map(p=>[p,digest(fs.readFileSync(p))]))});console.log(name+' passed');
}
assert.deepEqual(inventory(),before);assert.deepEqual(fs.readFileSync(directory+'/input.json'),input);
fs.writeFileSync(directory+'/iteration-native.json',JSON.stringify({passed:true,reportSha256:receipt.reportSha256,inputSha256:digest(input),checkerSha256:digest(fs.readFileSync(import.meta.path)),sourceHashes:before,expected,replays},null,2)+'\n');console.log(expected.length+' iteration cases and four faults passed');
