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
const source=await checkedProgram(program.source.source),schema=program.source.schema,types=new Map<string,any>(schema.types.map((t:any)=>[t.name,t])),signature=schema.exports[0];
const c=(type:string,tag:number,...values:any[])=>{const v=types.get(type).variants[tag];assert.equal(values.length,v.fields.length);return {constructor:v.name,fields:Object.fromEntries(v.fields.map((f:any,i:number)=>[f.name,values[i]]))};};
const field=(type:string,i:number)=>types.get(type).variants[0].fields[i].type;
const [ctx,st,ix,meta,win]=signature.args,keyType=field(ctx,0),wordType=field(ctx,2),vec=field(win,1),pair=field(vec,1);
const key=(n:number)=>c(keyType,0,...Array(8).fill(n)),word=(n:number)=>c(wordType,0,n,0);
const item=(n:number)=>c('queue.Obligation',0,key(n),word(10));
const cases:any[]=[];
for(const stateTag of [0,1,2,3])for(const signed of [false,true])for(const actor of [1,9])for(const collection of [4,9])for(const instruction of [0,1,2,3]){
 const append=instruction===1,queue=c('queue.Queue',0,key(1),key(2),key(3),key(4),2,0,word(20));
 const state=c(st,stateTag,...([1,2].includes(stateTag)?[queue]:[]));
 const ins=instruction===0?c(ix,0,key(2),key(3)):instruction===1?c(ix,1,key(5),word(10)):instruction===2?c(ix,2):c(ix,3,2,2);
 const window=c(win,0,append?2:0,c(vec,0,append?0:2,c(pair,0,item(5),item(6))));
 const args=[c(ctx,0,key(actor),signed,word(100),key(collection)),state,ins,c(meta,0,stateTag===0?0:2,4),window];
 const result=evaluateCall(source.book,schema,'queue.process',args);
 if(stateTag===3)assert.equal((result as any).fields.code,2);
 if([1,2].includes(stateTag)&&(!signed||actor!==1||collection!==4))assert.equal((result as any).fields.code,1);
 cases.push({args,result});
}
const wide=(n:bigint)=>c(wordType,0,Number(n&0xffffffffn),Number(n>>32n));
const max=(1n<<64n)-1n;
function addBoundary(label:string,state:any,instruction:any,length:number,capacity:number,start:number,loaded:number,amounts:bigint[],code:number){
 const window=c(win,0,start,c(vec,0,loaded,c(pair,0,...amounts.map((n,i)=>c('queue.Obligation',0,key(5+i),wide(n))))));
 const args=[c(ctx,0,key(1),true,word(100),key(4)),state,instruction,c(meta,0,length,capacity),window];
 const result:any=evaluateCall(source.book,schema,'queue.process',args);
 if(code)assert.deepEqual(result,{constructor:'queue.Rejected',fields:{code}},label);
 else assert.equal(result.constructor,'queue.Accepted',label);
 cases.push({label,args,result});
}
for(const remaining of [0n,19n,20n,21n,max])for(const fuel of [0,1,2,3,64]){
 const state=c(st,2,c('queue.Queue',0,key(1),key(2),key(3),key(4),2,0,wide(remaining)));
 addBoundary(`settle-${remaining}-${fuel}`,state,c(ix,3,2,fuel),2,2,0,2,[10n,10n],fuel!==2?5:remaining<20n?4:remaining===20n?0:6);
}
for(const [count,cursor,page,start,loaded,length] of [[2,0,0,0,0,2],[2,0,3,0,3,2],[2,0,2,1,2,2],[2,0,2,0,1,2],[2,0,2,0,2,3],[2,3,1,3,1,2],[0xffffffff,0xfffffffe,2,0xfffffffe,2,0xffffffff]]){
 const state=c(st,2,c('queue.Queue',0,key(1),key(2),key(3),key(4),count,cursor,word(20)));
 addBoundary(`bad-window-${cases.length}`,state,c(ix,3,page,2),length,0xffffffff,start,loaded,[10n,10n],3);
}
for(const [remaining,amount] of [[0n,0n],[0n,max],[max,1n],[max-1n,1n]]){
 const state=c(st,1,c('queue.Queue',0,key(1),key(2),key(3),key(4),2,0,wide(remaining)));
 addBoundary(`append-wide-${remaining}-${amount}`,state,c(ix,1,key(5),wide(amount)),2,3,2,0,[0n,0n],amount===0n?3:remaining+amount>max?4:0);
}
for(const [length,capacity,start,loaded] of [[2,2,2,0],[3,4,3,0],[2,4,1,0],[2,4,2,1]]){
 const state=c(st,1,c('queue.Queue',0,key(1),key(2),key(3),key(4),2,0,word(20)));
 addBoundary(`append-window-${cases.length}`,state,c(ix,1,key(5),word(1)),length,capacity,start,loaded,[0n,0n],3);
}
function toC(type:string,value:any):string {const t=types.get(type);assert.ok(t);if(t.kind==='u32'){assert.ok(Number.isInteger(value)&&value>=0&&value<=0xffffffff);return `${value}u`;}if(t.kind==='bool'){assert.equal(typeof value,'boolean');return value?'1u':'0u';}const v=t.variants.find((v:any)=>v.name===value.constructor);assert.ok(v);return `${v.cMaker}(${v.fields.map((f:any)=>toC(f.type,value.fields[f.name])).join(',')})`;}
function equal(type:string,value:any,e:string):string {const t=types.get(type);if(t.kind!=='adt')return `((${e})==${toC(type,value)})`;const v=t.variants.find((v:any)=>v.name===value.constructor);assert.ok(v);return [`((${e}).tag==${v.tag}u)`,...v.fields.map((f:any,i:number)=>equal(f.type,value.fields[f.name],`(${e}).as.c${v.tag}.f${i}`))].join(' && ');}

const checks=cases.map(({args,result})=>`{ ${types.get(signature.result).cType} r=${signature.cName}(${args.map((v:any,i:number)=>toC(signature.args[i],v)).join(',')}); if(!(${equal(signature.result,result,'r')}))return 42; }`).join('\n');
const rows=[];
for(const label of ['baseline','omit-signer','wrong-owner','append-two','skip-state-update']){
 const body=label==='baseline'?program.artifact.c:fs.readFileSync(`${dir}/${label}.c`,'utf8'),file=`${dir}/native-boundary-${label}.c`,exe=file+'.out';
 fs.writeFileSync(file,body+`\nint main(void){${checks}\nreturn 0;}\n`);
 const compile=spawnSync(process.env.CC??'clang',['-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all',file,'-o',exe],{encoding:'utf8',timeout:60000});
 fs.writeFileSync(file+'.compile.log',(compile.stdout??'')+(compile.stderr??''));assert.ifError(compile.error);assert.equal(compile.status,0,compile.stderr);
 const run=spawnSync(exe,[],{encoding:'utf8',timeout:10000});fs.writeFileSync(file+'.run.log',(run.stdout??'')+(run.stderr??''));assert.ifError(run.error);assert.equal(run.signal,null);assert.equal(run.status,label==='baseline'?0:42,label);assert.equal(run.stderr,'');
 rows.push({label,exitCode:run.status,files:Object.fromEntries([file,exe,file+'.compile.log',file+'.run.log'].map(p=>[p,digest(fs.readFileSync(p))]))});
}
for(const [p,h] of Object.entries(program.sourceHashes))assert.equal(digest(fs.readFileSync(p)),h);
assert.deepEqual(fs.readFileSync(`${dir}/input.json`),raw);
fs.writeFileSync(`${dir}/queue-native.json`,JSON.stringify({passed:true,endToEndVerified:false,inputSha256:digest(raw),reportSha256:receipt.reportSha256,checkerSha256:digest(fs.readFileSync(import.meta.path)),cases:cases.length,expected:cases,replays:rows,scope:'Checked Bend versus native emitted C with ASan/UBSan; explicit terminal and authorization expectations. No adapter/SBF theorem.'},null,2)+'\n');
console.log(cases.length+' queue cases and four native fault replays passed');
