import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sbfTools,run} from '../scripts/build.ts';
import {publishAcceptedFinalSbfArtifact,verifyFinalSbfArtifactReceipt} from '../compiler/sbf-call-depth-artifact.ts';
import {packedLoweringRun as parent} from './sha256-packed-lowering.ts';
import {prepareShaRunner,verifyShaRunner} from './sha-runner.ts';
import {checkShaRunnerControls} from './sha-runner-controls.ts';

const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const directory=path.join(parent,'sbf');fs.mkdirSync(directory);
const reportPath=path.join(parent,'report.json'),lowering=JSON.parse(fs.readFileSync(reportPath,'utf8'));assert.equal(lowering.passed,true);
const cases=JSON.parse(fs.readFileSync(path.join(parent,'cases.json'),'utf8'));assert.equal(cases.length,309);
const inputs:Record<string,string>={...lowering.inputs,[reportPath]:hash(reportPath),[path.resolve(import.meta.path)]:hash(import.meta.path)};
for(const [name,digest] of Object.entries(lowering.artifacts))inputs[path.join(parent,name)]=digest as string;
const requireInputs=()=>{for(const [file,digest] of Object.entries(inputs))assert.equal(hash(file),digest,file);};requireInputs();
const shell='tests/sha256-mixed-library/program.rs';inputs[path.resolve(shell)]=hash(shell);fs.copyFileSync(shell,path.join(directory,'program.rs'));fs.copyFileSync(path.join(parent,'library.bindings.rs'),path.join(directory,'library.bindings.rs'));
const tools=sbfTools(),rust=path.resolve(tools,'../../rust/bin/rustc'),readelf=path.join(tools,'llvm-readelf');
inputs[rust]=hash(rust);inputs[readelf]=hash(readelf);
const version=run(rust,['--version','--verbose'],true);assert(version.includes('1.89.0-dev')&&version.includes('LLVM version: 20.1.7'));
function profile(elf:string,qualified:boolean){
 assert.match(run(readelf,['-h',elf],true),/Flags:\s+0x0\b/);const lines=run(readelf,['-s',elf],true).split('\n');
 const imports=lines.filter(l=>/\bUND\b/.test(l)).map(l=>l.trim().split(/\s+/).at(-1)!).filter(n=>n!=='UND');
 assert(imports.every(n=>['abort','sol_sha256','sol_set_return_data','sol_memcpy_','sol_memmove_','sol_memset_','sol_memcmp_'].includes(n)));
 if(qualified)for(const name of ['abort','sol_sha256']){const matches=lines.filter(l=>l.trim().split(/\s+/).at(-1)===name);assert(matches.length&&matches.every(l=>/\bUND\b/.test(l)),'required syscall '+name);}
 else assert(!imports.includes('sol_sha256'));
 const stack=run(readelf,['--stack-sizes',elf],true),frames=[...stack.matchAll(/^\s+(\d+)\s+\S+/gm)].map(m=>Number(m[1]));assert(frames.length&&Math.max(...frames)<=4096);return {imports,rustMaxFrameBytes:Math.max(...frames)};
}
const images:any[]=[];
for(const name of ['ordinary','qualified']){
 const object=path.join(parent,name==='ordinary'?'library.sbf.o':'qualified.sbf.o'),elf=path.join(directory,name+'.so'),objectSha256=hash(object);
 run(rust,['--edition=2021','--crate-type=cdylib','--target','sbpf-solana-solana','-C','target-cpu=generic','-C','opt-level=2','-C','panic=abort','-Z','emit-stack-sizes=yes','-C','link-arg='+object,path.join(directory,'program.rs'),'-o',elf]);
 const elfSha256=hash(elf),result=profile(elf,name==='qualified');assert.equal(hash(object),objectSha256);
 const accepted=publishAcceptedFinalSbfArtifact(elf,path.join(directory,name+'-call-depth'),receipt=>{verifyFinalSbfArtifactReceipt(receipt,elf);assert.equal(hash(elf),elfSha256);assert.equal(receipt.artifact.sha256,elfSha256);return receipt;});
 images.push({name,elf,elfSha256,objectSha256,...result,callDepth:accepted.result});
}
assert.throws(()=>profile(images[0].elf,true),/required syscall/);
const original=fs.readFileSync(images[1].elf),changed=Buffer.from(original);changed[changed.length-1]^=1;
try{fs.writeFileSync(images[1].elf,changed);assert.throws(()=>verifyFinalSbfArtifactReceipt(images[1].callDepth,images[1].elf));}finally{fs.writeFileSync(images[1].elf,original);}
verifyFinalSbfArtifactReceipt(images[1].callDepth,images[1].elf);
// Retain the executing runner so later Cargo commands cannot erase this input.
const preparedRunner=prepareShaRunner(path.join(directory,'runner'));
const runnerControls=checkShaRunnerControls(preparedRunner,path.join(directory,'runner-controls'));
const runner=preparedRunner.receipt.executable.path;
Object.assign(inputs,preparedRunner.receipt.sourceHashes,preparedRunner.receipt.toolHashes,preparedRunner.receipt.evidenceHashes,
  runnerControls.report.sourceHashes,{[runner]:hash(runner),[preparedRunner.file]:hash(preparedRunner.file),[runnerControls.file]:hash(runnerControls.file)});
function execute(commands:any[]){verifyShaRunner(preparedRunner.receipt);const result=spawnSync(runner,[],{input:commands.map(c=>JSON.stringify(c)).join('\n')+'\n',encoding:'utf8',timeout:240000,maxBuffer:32*1024*1024});assert.ifError(result.error);assert.equal(result.status,0,result.stderr);verifyShaRunner(preparedRunner.receipt);const parsed=result.stdout.trim().split('\n').map(line=>JSON.parse(line));assert.equal(parsed.length,commands.length);return parsed.map(p=>{assert(p.success,p.error);return p.value;});}
const init=[{op:'hello'},{op:'key',seed:141},{op:'key',seed:142}],keys=execute(init);assert.equal(keys[0].runtime,'LiteSVM 0.7.1');
const commands:any[]=[...init];for(const [i,image] of images.entries())commands.push({op:'load',program:keys[i+1],elf:image.elf});
const indices:any[]=[];
for(const item of cases)for(const [i,image] of images.entries()){
 indices.push({name:image.name,case:item.name,expected:item.expected,status:item.status,program:keys[i+1],index:commands.length});
 commands.push({op:'send',instructions:[{program:'ComputeBudget111111111111111111111111111111',accounts:[],data:[2,192,92,21,0]},{program:keys[i+1],accounts:[],data:item.input}]});
}
const responses=execute(commands),rows=indices.map(item=>{const result=responses[item.index];if(item.status){assert.equal(result.ok,false);assert.equal(result.code,100+item.status);assert(!result.logs.some((l:string)=>l.startsWith('Program return: '+item.program+' ')));}else{assert(result.ok,JSON.stringify(result));const prefix='Program return: '+item.program+' ';const returns=result.logs.filter((l:string)=>l.startsWith(prefix));assert.equal(returns.length,1);assert.deepEqual([...Buffer.from(returns[0].slice(prefix.length),'base64')],item.expected,item.case+' '+item.name);}return {name:item.name,case:item.case,ok:result.ok,units:result.units};});
const raw=path.join(directory,'execution.json');fs.writeFileSync(raw,JSON.stringify({commands,responses},null,2)+'\n');requireInputs();
for(const image of images){assert.equal(hash(image.elf),image.elfSha256);verifyFinalSbfArtifactReceipt(image.callDepth,image.elf);}
const artifacts=Object.fromEntries(fs.readdirSync(directory).filter(n=>fs.statSync(path.join(directory,n)).isFile()).map(n=>[n,hash(path.join(directory,n))]));
const report={passed:true,endToEndVerified:false,casesPerImage:309,executions:rows.length,computeBudget:1400000,inputs,images,rows,artifacts,runner:preparedRunner.receipt,runnerControls:runnerControls.report,controls:['missing-required-final-import','changed-final-ELF-bytes'],scope:'Fresh maintained packed qualification and native controls, two Rust-linked final image profiles and artifact/call-depth gates, and actual ordinary/qualified LiteSVM SHA/rejection parity vs Node crypto. Finite measurements only; valid ABI memory, Bend/LLVM, SHA syscall, stable trusted process/filesystem and runtime remain assumptions. Qualified publication workflow and complete assurance aggregate are separate.'};
const file=path.join(directory,'report.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:true,casesPerImage:309,executions:rows.length,case138:rows.filter(r=>r.case==='length-138-poison-255'),report:file}));
