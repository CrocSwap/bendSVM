import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {checkedProgram} from '../compiler/backend.ts';
import {evaluateCall} from '../verification/reference.ts';
import {digest,inventory} from '../verification/check-acyclic-lowering.ts';
import {effectLayout} from '../compiler/effects.ts';
import type {WireValue} from '../sdk/wire.ts';
import type {PureCase} from '../tests/pure.ts';
const receipt=JSON.parse(fs.readFileSync('build/ranked-lowering/fresh-receipt.json','utf8'));
assert.equal(receipt.passed,true);
const directory=receipt.inputArtifact.slice(0,-'/input.json'.length),input=fs.readFileSync(receipt.inputArtifact),data=JSON.parse(input.toString()),program=data.programs[0];
assert.equal(digest(input),receipt.inputSha256);assert.equal(digest(fs.readFileSync(receipt.reportArtifact)),receipt.reportSha256);
assert.deepEqual(inventory(),data.sourceHashes);
const before=inventory(),source=await checkedProgram(program.source.source),schema=program.source.schema,types=new Map<string,any>(schema.types.map((t:any)=>[t.name,t]));
const signature=schema.exports.find((e:any)=>e.name==='batch.process');assert.ok(signature);
function casesFor(schema:any){
    const type=(name:string)=>{const t=schema.types.find(t=>t.name===name)!;assert(t.kind==='adt');return t;};
    const field=(name:string,tag:number,index:number)=>type(name).variants[tag].fields[index].type;
    const c=(name:string,tag:number,...values:WireValue[]):WireValue=>{
      const v=type(name).variants[tag];return {constructor:v.name,fields:Object.fromEntries(v.fields.map((f,i)=>[f.name,values[i]]))};
    };
    const root=schema.exports[0],[context,state,ix]=root.args,out=root.result;
    const batch=field(state,1,0),keyType=field(context,0,0),wordType=field(context,0,2);
    const vector=field(batch,0,3),store=field(vector,0,1),pair=field(store,0,0),item=field(pair,0,0);
    const effects=field(out,0,1),es=field(effects,0,1),ep=field(es,0,0),effect=effectLayout(schema,effects).type;
    const detail=field(effect,5,0),binding=field(effect,5,1),recipient=field(detail,0,4),authority=field(detail,0,6);
    const key=(n:number)=>c(keyType,0,...Array(8).fill(n));
    const word=(n:bigint)=>c(wordType,0,Number(n&0xffffffffn),Number(n>>32n));
    const pack=(outer:string,inner:string,xs:WireValue[])=>c(outer,0,c(inner,0,xs[0],xs[1]),c(inner,0,xs[2],xs[3]));
    const ev=(active:WireValue[])=>c(effects,0,active.length,pack(es,ep,[...active,...Array(4-active.length).fill(c(effect,0))]));
    const transfer=(fund:boolean,index:number,amount:bigint)=>c(effect,5,
      c(detail,0,4,fund?5:6+index,fund?6:5,key(2),fund?c(recipient,1):c(recipient,2,key(10+index)),word(amount),c(authority,fund?0:1)),
      fund?c(binding,0):c(binding,1,key(3)),fund?c(binding,1,key(3)):c(binding,0),false);
    const reject=(code:number)=>c(out,1,code),max=(1n<<64n)-1n;
    const cases:PureCase[]=[];
    for(const amounts of [[10n,20n,30n,40n],[0n,1n,max,1n],[max,1n,1n,1n]])
    for(const [length,fuel] of [[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[2,1],[1,2],[1,64],[0xffffffff,1]]) {
      const obligations=c(vector,0,length,pack(store,pair,amounts.map((a,i)=>c(item,0,key(10+i),word(a)))));
      let total=0n,error=0;
      if(length>4||length!==fuel)error=3;
      else for(const amount of amounts.slice(0,length)) {if(!amount){error=3;break;}total+=amount;if(total>max){error=4;break;}}
      const stored=total<=max?total:0n;
      for(const signed of [false,true]) {
        const ctx=c(context,0,key(1),signed,word(100n));
        const init=c(ix,0,key(2),key(3),obligations,fuel);
        const expected=!signed?reject(1):error?reject(error):total===0n?reject(3):
          c(out,0,c(state,1,c(batch,0,key(1),key(2),key(3),obligations,fuel,word(total))),ev([transfer(true,0,total)]));
        cases.push({name:'process',args:[ctx,c(state,0),init],expected});
        const funded=c(state,1,c(batch,0,key(1),key(2),key(3),obligations,fuel,word(stored)));
        const settleExpected=!signed?reject(1):length>4||length!==fuel?reject(5):error?reject(error):total===0n?reject(6):
          c(out,0,c(state,2),ev(amounts.slice(0,length).map((a,i)=>transfer(false,i,a))));
        cases.push({name:'process',args:[ctx,funded,c(ix,1)],expected:settleExpected});
      }
    }
    return cases;
}
function toC(type:string,value:any):string {const t=types.get(type);assert.ok(t);if(t.kind==='u32'){assert.ok(Number.isInteger(value)&&value>=0&&value<=0xffffffff);return `${value}u`;}if(t.kind==='bool'){assert.equal(typeof value,'boolean');return value?'1u':'0u';}const v=t.variants.find((v:any)=>v.name===value.constructor);assert.ok(v);return `${v.cMaker}(${v.fields.map((f:any)=>toC(f.type,value.fields[f.name])).join(',')})`;}
function equal(type:string,value:any,e:string):string {const t=types.get(type);if(t.kind!=='adt')return `((${e})==${toC(type,value)})`;const v=t.variants.find((v:any)=>v.name===value.constructor);assert.ok(v);return [`((${e}).tag==${v.tag}u)`,...v.fields.map((f:any,i:number)=>equal(f.type,value.fields[f.name],`(${e}).as.c${v.tag}.f${i}`))].join(' && ');}

const cases=casesFor(schema);
const expected=cases.map(({args,expected},i)=>{const result=evaluateCall(source.book,schema,'batch.process',args);assert.deepEqual(result,expected,'Bend case '+i);return {label:'case-'+i,args,result};});
const original=program.artifact.c;
function mutation(loop:number,old:string,replacement:string){
 const marker='sdk_2f_iteration_2e_repeat_7e_'+loop+'(';const pos=original.indexOf(marker);assert.ok(pos>=0);
 const start=original.lastIndexOf('static ',pos),end=original.indexOf('\n}',pos)+2;const body=original.slice(start,end);assert.equal(body.split(old).length,2);
 return original.slice(0,start)+body.replace(old,replacement)+original.slice(end);
}
const variants:[string,string,number][]=[['baseline',original,0]];
for(const loop of [0,1]){
 const marker='sdk_2f_iteration_2e_repeat_7e_'+loop+'(';const pos=original.indexOf(marker),end=original.indexOf('\n}',pos)+2,body=original.slice(pos,end);
 const update=body.match(/a1 = next[0-9]+;/)![0],fuel=body.match(/a0 = next[0-9]+;/)![0];
 variants.push(['skip-state-'+loop,mutation(loop,update,'a1 = a1;'),42]);
 variants.push(['early-stop-'+loop,mutation(loop,fuel,'a0 = 0u;'),42]);
}
const replays=[];
for(const [label,c,wanted] of variants){
 const path=directory+'/native-batch-'+label+'.c',exe=path+'.out';
 const checks=expected.map(({args,result})=>`{ ${types.get(signature.result).cType} r=${signature.cName}(${args.map((v:any,i:number)=>toC(signature.args[i],v)).join(',')}); if(!(${equal(signature.result,result,'r')}))return 42; }`).join('\n');
 fs.writeFileSync(path,c+`\nint main(void){\n${checks}\nreturn 0;}\n`);
 const compiled=spawnSync(process.env.CC??'clang',['-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all',path,'-o',exe],{encoding:'utf8',timeout:60000});
 const log=path+'.compile.log';fs.writeFileSync(log,(compiled.stdout??'')+(compiled.stderr??''));assert.ifError(compiled.error);assert.equal(compiled.status,0,compiled.stderr);
 const run=spawnSync(exe,[],{encoding:'utf8',timeout:10000});fs.writeFileSync(path+'.run.log',(run.stdout??'')+(run.stderr??''));assert.ifError(run.error);assert.equal(run.signal,null);assert.equal(run.status,wanted,label);assert.equal(run.stderr,'');
 replays.push({label,exitCode:run.status,cSha256:digest(c),files:Object.fromEntries([path,exe,log,path+'.run.log'].map(p=>[p,digest(fs.readFileSync(p))]))});
 console.log(label+' passed');
}
assert.deepEqual(inventory(),before);assert.deepEqual(fs.readFileSync(directory+'/input.json'),input);
fs.writeFileSync(directory+'/batch-native.json',JSON.stringify({passed:true,reportSha256:receipt.reportSha256,endToEndVerified:false,inputSha256:digest(input),checkerSha256:digest(fs.readFileSync(import.meta.path)),expected,replays,sourceHashes:before,scope:'Pure batch root: independent expected cases versus checked Bend and actual emitted host C under ASan/UBSan; four terminating loop faults. Excludes adapters and SBF.'},null,2)+'\n');
console.log(expected.length+' native batch cases and four loop faults passed');
