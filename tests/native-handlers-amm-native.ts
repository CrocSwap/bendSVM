import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {checkedProgram} from '../compiler/backend.ts';
import {evaluateCall} from '../verification/reference.ts';
import {digest} from '../verification/check-acyclic-lowering.ts';
import {boundInventory as inventory} from '../verification/check-native-handlers.ts';
import path from 'node:path';
const receipt=JSON.parse(fs.readFileSync('build/native-handler-lowering/fresh-receipt.json','utf8'));
assert.equal(receipt.passed,true);
const directory=path.dirname(receipt.inputArtifact),input=fs.readFileSync(receipt.inputArtifact),data=JSON.parse(input.toString()),program=data.programs.find((p:any)=>p.source.source==='examples/amm/PROOF.bend');
assert.ok(program);assert.equal(digest(input),receipt.inputSha256);assert.equal(digest(fs.readFileSync(receipt.reportArtifact)),receipt.reportSha256);
assert.deepEqual(inventory(),data.sourceHashes);
const before=inventory(),root='amm.process',source=await checkedProgram(program.source.source),schema=program.source.schema,types=new Map<string,any>(schema.types.map((t:any)=>[t.name,t]));
const signature=schema.exports.find((e:any)=>e.name===root);assert.ok(signature);
const ctr=(constructor:string,fields:any={})=>({constructor,fields});
const amm=(name:string,fields:any={})=>ctr(`amm.${name}`,fields);
const word=(n:bigint|number)=>ctr('../../sdk/math.U64',{lo:Number(BigInt(n)&0xffffffffn),hi:Number(BigInt(n)>>32n)});
const key=(n:number)=>ctr('../../sdk/context.Key',Object.fromEntries('abcdefgh'.split('').map((k,i)=>[k,i===0?n:0])));
const context=(signed=true)=>ctr('../../sdk/context.Context',{actor:key(1),signed,slot:word(0)});
const config=(quote=3)=>amm('Config',{base:key(2),quote:key(quote),lp:key(4),base_vault:key(5),quote_vault:key(6)});
const pool=(base:bigint|number=10000,quote:bigint|number=40000,shares:bigint|number=20000)=>amm('Open',{pool:amm('Pool',{config:config(),balances:amm('Balances',{base:word(base),quote:word(quote),shares:word(shares)})})});
const init=(base:bigint|number=10000,quote:bigint|number=40000,min:bigint|number=19000,cfg=config())=>amm('Initialize',{config:cfg,base:word(base),quote:word(quote),min_shares:word(min)});
const swap=(base_in:boolean,amount:bigint|number,min:bigint|number)=>amm('Swap',{base_in,amount:word(amount),min_output:word(min)});
const deposit=(shares:bigint|number,x:bigint|number,y:bigint|number)=>amm('Deposit',{shares:word(shares),max_base:word(x),max_quote:word(y)});
const withdraw=(shares:bigint|number,x:bigint|number,y:bigint|number)=>amm('Withdraw',{shares:word(shares),min_base:word(x),min_quote:word(y)});
const cases:[string,any[],string][]=[
 ['unsigned-init',[context(false),amm('Empty'),init()],'Rejected'],
 ['initialize',[context(),amm('Empty'),init()],'Accepted'],
 ['wide-initialize',[context(),amm('Empty'),init(1n<<40n,1n<<44n,(1n<<42n)-1000n)],'Accepted'],
 ['duplicate-mints',[context(),amm('Empty'),init(10000,40000,19000,config(2))],'Rejected'],
 ['init-limit',[context(),amm('Empty'),init(10000,40000,19001)],'Rejected'],
 ['locked-initialize',[context(),amm('Empty'),init(1000,1000,0)],'Rejected'],
 ['reinitialize',[context(),pool(),init()],'Rejected'],
 ['empty-swap',[context(),amm('Empty'),swap(true,100,0)],'Rejected'],
 ['deposit',[context(),pool(),deposit(1000,500,2000)],'Accepted'],
 ['rounded-deposit',[context(),pool(10003,40007,20000),deposit(7,4,15)],'Accepted'],
 ['deposit-limit',[context(),pool(),deposit(1000,499,2000)],'Rejected'],
 ['withdraw',[context(),pool(),withdraw(1000,500,2000)],'Accepted'],
 ['locked-withdraw',[context(),pool(),withdraw(19001,0,0)],'Rejected'],
 ['withdraw-limit',[context(),pool(),withdraw(1000,501,2000)],'Rejected'],
 ['swap-base',[context(),pool(),swap(true,100,390)],'Accepted'],
 ['swap-quote',[context(),pool(),swap(false,100,20)],'Accepted'],
 ['swap-limit',[context(),pool(),swap(true,100,500)],'Rejected'],
 ['zero-swap',[context(),pool(),swap(true,0,0)],'Rejected'],
 ['wide-swap',[context(),pool(1n<<40n,1n<<42n,1n<<41n),swap(true,1n<<32n,0)],'Accepted'],
 ['unsigned-swap',[context(false),pool(),swap(true,100,0)],'Rejected'],
];
const expected=cases.map(([label,args,outcome])=>{const result=evaluateCall(source.book,schema,root,args);assert.equal(result.constructor,`amm.${outcome}`,label);return {label,args,result};});
function toC(type:string,value:any):string {const t=types.get(type);assert.ok(t);if(t.kind==='u32'){assert.ok(Number.isInteger(value)&&value>=0&&value<=0xffffffff);return `${value}u`;}if(t.kind==='bool'){assert.equal(typeof value,'boolean');return value?'1u':'0u';}const v=t.variants.find((v:any)=>v.name===value.constructor);assert.ok(v);return `${v.cMaker}(${v.fields.map((f:any)=>toC(f.type,value.fields[f.name])).join(',')})`;}
function equal(type:string,value:any,e:string):string {const t=types.get(type);if(t.kind!=='adt')return `((${e})==${toC(type,value)})`;const v=t.variants.find((v:any)=>v.name===value.constructor);assert.ok(v);return [`((${e}).tag==${v.tag}u)`,...v.fields.map((f:any,i:number)=>equal(f.type,value.fields[f.name],`(${e}).as.c${v.tag}.f${i}`))].join(' && ');}
const original=program.artifact.c;
function change(fn:string,old:string,replacement:string){const start=original.indexOf(`static inline bend_amm_2e_Outcome_t bend_amm_2e_${fn}(`),end=original.indexOf('\n}',start)+2;assert.ok(start>=0&&end>start);const body=original.slice(start,end);assert.equal(body.split(old).length,2);return original.slice(0,start)+body.replace(old,replacement)+original.slice(end);}
const auth=change('signed','return bend_amm_2e_Rejected_make(1u);','return bend_amm_2e_dispatch(a1, a2);');
const guard=change('guard','return bend_amm_2e_Rejected_make(a1);','return a2;');
const product=original.replace('(unsigned long long)a0 * (unsigned long long)a1','(unsigned long long)a0 + (unsigned long long)a1');assert.notEqual(product,original);
const marker='bend__2e__2e__2f__2e__2e__2f_sdk_2f_issuance_2e_TransferDetails_make(5u, 4u, 6u,';assert.equal(original.split(marker).length,2);const role=original.replace(marker,marker.replace('(5u, 4u','(8u, 4u'));
const selected=(label:string)=>{const row=expected.find(c=>c.label===label);assert.ok(row);return [row];};
const replays=[];
for(const [label,c,rows,wanted] of [['baseline',original,expected,0],['authorization',auth,selected('unsigned-init'),42],['slippage',guard,selected('swap-limit'),42],['native-product',product,selected('initialize'),42],['reserve-role',role,selected('withdraw'),42]] as const){
 const path=`${directory}/native-${label}.c`,exe=path+'.out';
 const checks=rows.map(({args,result})=>`{ ${types.get(signature.result).cType} r=${signature.cName}(${args.map((v:any,i:number)=>toC(signature.args[i],v)).join(',')}); if(!(${equal(signature.result,result,'r')}))return 42; }`).join('\n');
 fs.writeFileSync(path,c+`\nint main(void){\n${checks}\nreturn 0;}\n`);
 const compiled=spawnSync(process.env.CC??'clang',['-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all',path,'-o',exe],{encoding:'utf8',timeout:30000});const log=path+'.compile.log';fs.writeFileSync(log,(compiled.stdout??'')+(compiled.stderr??''));assert.ifError(compiled.error);assert.equal(compiled.status,0,compiled.stderr);
 const result=spawnSync(exe,[],{encoding:'utf8',timeout:10000});fs.writeFileSync(path+'.run.log',(result.stdout??'')+(result.stderr??''));assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,wanted,label);assert.equal(result.stderr,'');
 replays.push({label,exitCode:result.status,cSha256:digest(c),cases:rows.map(r=>r.label),files:Object.fromEntries([path,exe,log,path+'.run.log'].map(p=>[p,digest(fs.readFileSync(p))]))});
}
assert.deepEqual(inventory(),before);assert.deepEqual(fs.readFileSync(receipt.inputArtifact),input);
fs.writeFileSync(`${directory}/amm-native.json`,JSON.stringify({passed:true,endToEndVerified:false,inputSha256:digest(input),checkerSha256:digest(fs.readFileSync(import.meta.path)),expected,replays,sourceHashes:before},null,2)+'\n');console.log('20 AMM root cases and four native fault replays passed');
