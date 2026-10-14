import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {checkedProgram} from '../compiler/backend.ts';
import {evaluateCall} from '../verification/reference.ts';
import {digest,inventory} from '../verification/check-acyclic-lowering.ts';
import path from 'node:path';
import {boundInventory} from '../verification/check-native-handlers.ts';
const receipt=JSON.parse(fs.readFileSync('build/native-handler-lowering/fresh-receipt.json','utf8'));
const inputBytes=fs.readFileSync(receipt.inputArtifact),data=JSON.parse(inputBytes.toString());
assert.equal(digest(inputBytes),receipt.inputSha256);
assert.equal(digest(fs.readFileSync(receipt.reportArtifact)),receipt.reportSha256);
const before=boundInventory();assert.deepEqual(before,receipt.sourceHashes);
const directory=path.dirname(receipt.reportArtifact),rows=[];
const ctr=(constructor:string,fields:any={})=>({constructor,fields});
const word=(n:bigint|number)=>ctr('../../sdk/math.U64',{lo:Number(BigInt(n)&0xffffffffn),hi:Number(BigInt(n)>>32n)});
const key=(n:number)=>ctr('../../sdk/context.Key',Object.fromEntries('abcdefgh'.split('').map((k,i)=>[k,i===0?n:0])));
const context=(signed:boolean,slot:number,actor=1)=>ctr('../../sdk/context.Context',{actor:key(actor),signed,slot:word(slot)});
for(const name of ['vesting','exchange']) {
 const root=`${name}.process`;
 const ctr=(constructor:string,fields:any={})=>({constructor:constructor.includes('.')?constructor:`${name}.${constructor}`,fields});
 const inputPath=receipt.inputArtifact,program=data.programs.find((p:any)=>p.source.source===`examples/${name}/PROOF.bend`);assert.ok(program);
 assert.equal(digest(program.artifact.c),program.artifact.cSha256);
 for(const [p,h] of Object.entries(program.sourceHashes))assert.equal(digest(fs.readFileSync(p)),h);
 const schema=program.source.schema,types=new Map<string,any>(schema.types.map((t:any)=>[t.name,t]));
 const source=await checkedProgram(program.source.source),signature=schema.exports.find((e:any)=>e.name===root);assert.ok(signature);
 let cases:any[];
 if(name==='vesting') {
  const init=ctr('Initialize',{beneficiary:key(1),mint:key(2),total:word(100),start:word(0),end:word(4)});
  const live=(total:bigint|number=100,claimed=0)=>ctr('Live',{schedule:ctr('Schedule',{beneficiary:key(1),mint:key(2),total:word(total),start:word(0),end:word(4),claimed:word(claimed)})});
  cases=[['unsigned-initialize',[context(false,0),ctr('Empty'),init]],['signed-initialize',[context(true,0),ctr('Empty'),init]],
   ['arithmetic',[context(true,2),live(),ctr('Claim')]],['full-width',[context(true,2),live((1n<<64n)-1n),ctr('Claim')]],
   ['deadline',[context(true,4),live(),ctr('Claim')]],['zero-delta',[context(true,2),live(100,50),ctr('Claim')]],
   ['wrong-beneficiary',[context(true,2,3),live(),ctr('Claim')]],['before-start',[context(true,0),live(),ctr('Claim')]]];
 } else {
  const init=ctr('Initialize',{base:key(2),quote:key(3),amount:word(100),numerator:word(7),denominator:word(2)});
  const open=(remaining:bigint|number=100,numerator:bigint|number=7,denominator=2)=>ctr('Open',{offer:ctr('Offer',{maker:key(1),base:key(2),quote:key(3),remaining:word(remaining),numerator:word(numerator),denominator:word(denominator)})});
  const fill=(amount:bigint|number=3,max:bigint|number=11)=>ctr('Fill',{amount:word(amount),max_payment:word(max)});
  cases=[['unsigned-initialize',[context(false,0),ctr('Empty'),init]],['signed-initialize',[context(true,0),ctr('Empty'),init]],
   ['arithmetic',[context(true,0,4),open(),fill()]],['full-width',[context(true,0,4),open(0xffffffffn,0xffffffffn,1),fill(0xffffffffn,0xfffffffe00000001n)]],
   ['slippage',[context(true,0,4),open(),fill(3,10)]],['cancel',[context(true,0),open(),ctr('Cancel')]],
   ['wrong-maker',[context(true,0,4),open(),ctr('Cancel')]],['zero-denominator',[context(true,0,4),open(100,7,0),fill()]]];
 }
 function toC(type:string,value:any):string {
  const t=types.get(type);assert.ok(t);
  if(t.kind==='u32'){assert.ok(Number.isInteger(value)&&value>=0&&value<=0xffffffff);return `${value}u`;}
  if(t.kind==='bool'){assert.equal(typeof value,'boolean');return value?'1u':'0u';}
  const v=t.variants.find((v:any)=>v.name===value.constructor);assert.ok(v);
  return `${v.cMaker}(${v.fields.map((f:any)=>toC(f.type,value.fields[f.name])).join(',')})`;
 }
 function equal(type:string,value:any,expression:string):string {
  const t=types.get(type);if(t.kind!=='adt')return `((${expression})==${toC(type,value)})`;
  const v=t.variants.find((v:any)=>v.name===value.constructor);assert.ok(v);
  return [`((${expression}).tag==${v.tag}u)`,...v.fields.map((f:any,i:number)=>equal(f.type,value.fields[f.name],`(${expression}).as.c${v.tag}.f${i}`))].join(' && ');
 }
 const expected=cases.map(([label,args])=>({label,args,result:evaluateCall(source.book,schema,root,args)}));
 assert.deepEqual(expected[0].result,ctr('Rejected',{code:1}));
 assert.equal(expected[1].result.constructor,`${name}.Accepted`);assert.equal(expected[2].result.constructor,`${name}.Accepted`);assert.equal(expected[3].result.constructor,`${name}.Accepted`);
 const original=program.artifact.c,start=original.indexOf(`static inline bend_${name}_2e_Outcome_t bend_${name}_2e_authorize(`),end=original.indexOf('\n}',start)+2;
 const section=original.slice(start,end);assert.equal(section.split(`return bend_${name}_2e_Rejected_make(1u);`).length,2);
 const authorization=original.slice(0,start)+section.replace(`return bend_${name}_2e_Rejected_make(1u);`,'return a1;')+original.slice(end);
 const product=original.replace('(unsigned long long)a0 * (unsigned long long)a1','(unsigned long long)a0 + (unsigned long long)a1');assert.notEqual(product,original);
 const replays=[];
 for(const [label,c,selected,wanted] of [['baseline',original,expected,0],['authorization-fault',authorization,[expected[0]],42],['product-fault',product,[expected[2]],42]] as const) {
  const path=`${directory}/${name}-root-${label}.c`,exe=path+'.out';
  const checks=selected.map(({args,result},i)=>`{ ${types.get(signature.result).cType} r = ${signature.cName}(${args.map((a:any,j:number)=>toC(signature.args[j],a)).join(',')}); if (!(${equal(signature.result,result,'r')})) return 42; }`).join('\n');
  fs.writeFileSync(path,c+`\nint main(void) {\n${checks}\nreturn 0; }\n`);
  const compiled=spawnSync(process.env.CC??'clang',['-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all',path,'-o',exe],{encoding:'utf8',timeout:30000});
  const compileLog=path+'.compile.log';fs.writeFileSync(compileLog,(compiled.stdout??'')+(compiled.stderr??''));assert.ifError(compiled.error);assert.equal(compiled.status,0,compiled.stderr);
  const executed=spawnSync(exe,[],{encoding:'utf8',timeout:10000});
  const runLog=path+'.run.log';fs.writeFileSync(runLog,(executed.stdout??'')+(executed.stderr??''));assert.ifError(executed.error);assert.equal(executed.signal,null);assert.equal(executed.status,wanted,executed.stderr);assert.equal(executed.stderr,'');
  replays.push({label,exitCode:executed.status,files:Object.fromEntries([path,exe,compileLog,runLog].map(p=>[p,digest(fs.readFileSync(p))]))});
 }
 assert.deepEqual(fs.readFileSync(inputPath),inputBytes);
 rows.push({handler:name,inputSha256:digest(inputBytes),function:root,expected,replays});
}
assert.deepEqual(boundInventory(),before,'source drift');
fs.writeFileSync(`${directory}/native-root.json`,JSON.stringify({passed:true,exploratory:true,rows,sourceHashes:before,checkerSha256:digest(fs.readFileSync(import.meta.path))},null,2)+'\n');
console.log('16 complete handler cases match pinned Bend; four complete handler fault replays differ as expected under ASan/UBSan');
