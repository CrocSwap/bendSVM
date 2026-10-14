import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {run,sbfTools} from '../scripts/build.ts';
import {publishAcceptedFinalSbfArtifact,verifyFinalSbfArtifactReceipt} from '../compiler/sbf-call-depth-artifact.ts';
import {makeCases} from './sha256-mixed-library/cases.ts';
import {makePackedCases} from './sha256-packed-reference/cases.ts';
import {prepareShaRunner,verifyShaRunner} from './sha-runner.ts';
import {checkShaRunnerControls} from './sha-runner-controls.ts';

const root=path.resolve(import.meta.dir,'..');
const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function testQualifiedShaLibrary(profile:'short'|'packed') {
const packed=profile==='packed';
const fixture=packed?'tests/sha256-packed-reference':'tests/sha256-mixed-library';
const cli=packed?'scripts/build-sha256-packed-library.ts':'scripts/build-sha256-library.ts';
const catalog=packed?'compiler/sha256-packed-qualification-pins.json':'compiler/sha256-qualification-pins.json';
const manifestKind=packed?'sha256-packed-qualified-library-v1':'sha256-qualified-library-v1';
const entry=packed?'tests/sha256-packed-qualified-library.ts':'tests/sha256-qualified-library.ts';
const shell='tests/sha256-mixed-library/program.rs';
const preload='tests/sha256-mixed-library/failure-preload.ts';
const caseFile=packed?'tests/sha256-packed-reference/cases.ts':'tests/sha256-mixed-library/cases.ts';
const expectedNativeCases=packed?308:64;
const id=crypto.randomUUID(),output=path.join(root,packed?'build/sha256-packed-qualified-library':'build/sha256-qualified-library');
fs.mkdirSync(output,{recursive:true});
const runRoot=path.join(output,'run-'+id);fs.mkdirSync(runRoot);
const latest=path.join(output,'latest.json');
if(fs.existsSync(latest))fs.renameSync(latest,path.join(runRoot,'previous-latest.json'));
const source=fixture+'/PROOF.bend',runtimeRoot=packed?'program.hash_packed':'program.hash_short';
const directory=path.join(runRoot,'library'),active=path.join(directory,'active.json');
const ownFiles=[import.meta.path,entry,'scripts/qualified-library.ts',cli,shell,preload,caseFile,
  'scripts/build.ts','sdk/wire.ts','compiler/sbf-call-depth.ts','compiler/sbf-call-depth-artifact.ts','tests/sha-runner.ts','tests/sha-runner-controls.ts',
  'scripts/test-runner/Cargo.toml','scripts/test-runner/Cargo.lock','scripts/test-runner/src/main.rs',
  packed?'tests/sha256-mixed-library/cases.ts':'tests/sha256-packed-reference/cases.ts',
  ...['program.bend','PROOF.bend','LAWS.bend'].map(name=>fixture+'/'+name)];
const before=Object.fromEntries(ownFiles.map(file=>[path.resolve(file),hash(file)]));
const logs:{file:string;sha256:string}[]=[];
function build(label:string,proof=source,phase?:string,command=cli) {
  const args=phase?['--preload',path.resolve(preload)]:[];
  args.push(command,proof,runtimeRoot,directory);
  const child=spawnSync(process.execPath,args,{cwd:root,env:{...process.env,SHA_LIBRARY_TEST_FAILURE:phase??''},encoding:'utf8',timeout:600000,maxBuffer:8*1024*1024});
  const log=path.join(runRoot,label+'.log');fs.writeFileSync(log,(child.stdout??'')+(child.stderr??''));logs.push({file:log,sha256:hash(log)});
  assert.ifError(child.error);assert.equal(child.signal,null);
  return child;
}
function auditGeneration(manifest:any) {
  assert.equal(manifest.kind,manifestKind);assert.equal(manifest.qualificationProfile,profile);assert.equal(manifest.finalElfAuthorized,false);
  const generation=path.join(directory,manifest.generation);
  assert.deepEqual(fs.readdirSync(generation).sort(),Object.keys(manifest.artifacts).sort());
  for(const [name,record] of Object.entries(manifest.artifacts) as [string,any][]) {
    const file=path.join(generation,name);assert.equal(fs.statSync(file).size,record.bytes);assert.equal(hash(file),record.sha256,name);
  }
  for(const [file,digest] of Object.entries(manifest.inputs))assert.equal(hash(file),digest,file);
  assert.equal(manifest.selection.hostSource,'library.c');assert.equal(manifest.selection.sbfObject,'library.qualified.sbf.o');
  assert.equal(manifest.objectProfile.sha256,manifest.artifacts['library.qualified.sbf.o'].sha256);
  const qualification=JSON.parse(fs.readFileSync(path.join(generation,'qualification.json'),'utf8'));
  assert.equal(qualification.qualificationCatalogSha256,manifest.qualification.catalogSha256);
  assert.equal(hash(catalog),manifest.qualification.catalogSha256);
  assert.notEqual(manifest.artifacts['library.c'].sha256,manifest.artifacts['library.qualified.c'].sha256);
  return generation;
}
try {
  const first=build('initial');assert.equal(first.status,0,first.stderr);
  const saved=fs.readFileSync(active),prior=JSON.parse(saved.toString());auditGeneration(prior);
  const controls:any[]=[];
  for(const phase of ['after-ordinary','after-qualified-compile','after-build','before-manifest','ordinary-object-swap','object-after-profile-swap']) {
    if(!fs.existsSync(active))fs.writeFileSync(active,saved,{flag:'wx'});
    const previous=new Set(fs.readdirSync(directory));
    const child=build(phase,source,phase);assert.equal(child.status,1);
    const reason=phase==='ordinary-object-swap'?'Unsupported qualified library object imports':phase==='object-after-profile-swap'?'Qualified library object changed during profile checks':`Injected ${phase} failure`;
    assert(child.stderr.includes(reason),child.stderr);
    assert(!fs.existsSync(active));assert(!fs.existsSync(path.join(directory,'lock')));
    const added=fs.readdirSync(directory).filter(name=>!previous.has(name));
    const archives=added.filter(name=>name.startsWith('archive-'));assert.equal(archives.length,1);
    assert.deepEqual(fs.readFileSync(path.join(directory,archives[0])),saved);
    const failures=added.filter(name=>name.startsWith('failure-'));assert.equal(failures.length,1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory,failures[0]),'utf8')).passed,false);
    auditGeneration(prior);controls.push({phase,archive:archives[0],archiveSha256:hash(path.join(directory,archives[0])),failure:failures[0],failureSha256:hash(path.join(directory,failures[0])),exitCode:child.status});
  }
  // A real law hole checks retirement before the ordinary source/proof gate.
  const broken=path.join(runRoot,'broken');fs.mkdirSync(broken);
  for(const name of ['program.bend','PROOF.bend','LAWS.bend']) {
    let contents=fs.readFileSync(fixture+'/'+name,'utf8').replaceAll('../../sdk/',path.join(root,'sdk')+'/');
    if(name==='PROOF.bend')contents=contents.replace('{==}','?TODO');
    fs.writeFileSync(path.join(broken,name),contents);
  }
  fs.writeFileSync(active,saved,{flag:'wx'});
  const beforeProof=new Set(fs.readdirSync(directory));
  const proofFailure=build('proof-hole',path.join(broken,'PROOF.bend'));assert.equal(proofFailure.status,1);assert.match(proofFailure.stderr,/holes|open laws/);
  assert(!fs.existsSync(active));assert(!fs.existsSync(path.join(directory,'lock')));auditGeneration(prior);
  const proofAdded=fs.readdirSync(directory).filter(name=>!beforeProof.has(name));
  const proofArchive=proofAdded.filter(name=>name.startsWith('archive-'));assert.equal(proofArchive.length,1);
  assert.deepEqual(fs.readFileSync(path.join(directory,proofArchive[0])),saved);
  const proofRecord=proofAdded.filter(name=>name.startsWith('failure-'));assert.equal(proofRecord.length,1);
  controls.push({phase:'proof-hole',archive:proofArchive[0],archiveSha256:hash(path.join(directory,proofArchive[0])),failure:proofRecord[0],failureSha256:hash(path.join(directory,proofRecord[0])),exitCode:proofFailure.status});
  // Selecting the other fixed qualification profile cannot authorize this source.
  fs.writeFileSync(active,saved,{flag:'wx'});
  const beforeProfile=new Set(fs.readdirSync(directory));
  const mismatch=build('wrong-profile',source,undefined,packed?'scripts/build-sha256-library.ts':'scripts/build-sha256-packed-library.ts');
  assert.equal(mismatch.status,1);assert.match(mismatch.stderr,/required sha256-packed module|not emitted exactly once/);
  assert(!fs.existsSync(active));assert(!fs.existsSync(path.join(directory,'lock')));auditGeneration(prior);
  const profileAdded=fs.readdirSync(directory).filter(name=>!beforeProfile.has(name));
  const profileArchive=profileAdded.filter(name=>name.startsWith('archive-'));assert.equal(profileArchive.length,1);
  assert.deepEqual(fs.readFileSync(path.join(directory,profileArchive[0])),saved);
  const profileFailure=profileAdded.filter(name=>name.startsWith('failure-'));assert.equal(profileFailure.length,1);
  controls.push({phase:'wrong-profile',archive:profileArchive[0],archiveSha256:hash(path.join(directory,profileArchive[0])),failure:profileFailure[0],failureSha256:hash(path.join(directory,profileFailure[0])),exitCode:mismatch.status});
  // A competing build cannot retire success without owning the publication lock.
  fs.writeFileSync(active,saved,{flag:'wx'});const lock=path.join(directory,'lock');fs.mkdirSync(lock);
  const beforeLock=fs.readdirSync(directory).sort();
  try {
    const blocked=build('held-lock');assert.equal(blocked.status,1);assert.match(blocked.stderr,/EEXIST/);
    assert.deepEqual(fs.readFileSync(active),saved);assert.deepEqual(fs.readdirSync(directory).sort(),beforeLock);auditGeneration(prior);
    controls.push({phase:'held-lock',exitCode:blocked.status,priorActiveSha256:hash(active)});
  } finally {fs.rmdirSync(lock);}
  const restored=build('restoration');assert.equal(restored.status,0,restored.stderr);
  const manifest=JSON.parse(fs.readFileSync(active,'utf8'));assert.notEqual(manifest.id,prior.id);
  const generation=auditGeneration(manifest);auditGeneration(prior);
  const schema=JSON.parse(fs.readFileSync(path.join(generation,'library.schema.json'),'utf8')).schema;
  const exported=schema.exports[0];const cases=(packed?makePackedCases:makeCases)(schema,exported.args[0],exported.result);assert.equal(cases.length,expectedNativeCases);
  const link=path.join(runRoot,'link');fs.mkdirSync(link);
  fs.copyFileSync(shell,path.join(link,'program.rs'));
  fs.copyFileSync(path.join(generation,'library.bindings.rs'),path.join(link,'library.bindings.rs'));
  const header=path.join(generation,'library.h');
  const harness=path.join(link,'native.c'),native=path.join(link,'native');
  const cArrays=(values:number[])=>'{'+values.join(',')+'}';
  fs.writeFileSync(harness,`#include "${header}"\n#include <string.h>\n#include <stdio.h>\n`+
    `static const unsigned char inputs[${cases.length}][BEND_LIBRARY_INPUT_BYTES]={${cases.map(item=>cArrays(item.wire.slice(1))).join(',')}};\n`+
    `static const unsigned char expected[${cases.length}][BEND_LIBRARY_OUTPUT_BYTES]={${cases.map(item=>cArrays(item.expected)).join(',')}};\n`+
    `int main(void){for(unsigned i=0;i<${cases.length};i++){unsigned char output[BEND_LIBRARY_OUTPUT_BYTES];memset(output,0xa5,sizeof output);uint64_t length=99;`+
    `if(BEND_LIBRARY_CALL(inputs[i],sizeof inputs[i],output,sizeof output,&length)!=0||length!=sizeof output||memcmp(output,expected[i],sizeof output)){fprintf(stderr,"case %u\\n",i);return 1;}}return 0;}\n`);
  run(process.env.CC??'clang',['-std=c17','-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-Iruntime',harness,path.join(generation,'library.c'),'-o',native]);
  run(native,[]);
  const tools=sbfTools(),readelf=path.join(tools,'llvm-readelf'),rust=path.resolve(tools,'../../rust/bin/rustc');
  assert.match(run(rust,['--version','--verbose'],true),/LLVM version: 20\.1\.7/);
  function imageProfile(elf:string,qualified:boolean) {
    assert.match(run(readelf,['-h',elf],true),/Flags:\s+0x0\b/);
    const lines=run(readelf,['-s',elf],true).split('\n');
    const imports=lines.filter(line=>/\bUND\b/.test(line)).map(line=>line.trim().split(/\s+/).at(-1)!).filter(name=>name!=='UND');
    const allowed=['abort','sol_sha256','sol_set_return_data','sol_memcpy_','sol_memmove_','sol_memset_','sol_memcmp_'];
    assert(imports.every(name=>allowed.includes(name)));
    if(qualified)for(const name of ['abort','sol_sha256']) {
      const matches=lines.filter(line=>line.trim().split(/\s+/).at(-1)===name);
      assert(matches.length&&matches.every(line=>/\bUND\b/.test(line)),'required syscall import '+name);
    }
    else assert(!imports.includes('sol_sha256'));
    const stack=run(readelf,['--stack-sizes',elf],true);
    const frames=[...stack.matchAll(/^\s+(\d+)\s+\S+/gm)].map(match=>Number(match[1]));
    assert(frames.length&&Math.max(...frames)<=4096);
    return {imports,rustMaxFrameBytes:Math.max(...frames)};
  }
  const images:any[]=[];
  for(const name of ['ordinary','qualified']) {
    const object=path.join(generation,name==='ordinary'?'library.sbf.o':'library.qualified.sbf.o'),elf=path.join(link,name+'.so');
    run(rust,['--edition=2021','--crate-type=cdylib','--target','sbpf-solana-solana','-C','target-cpu=generic','-C','opt-level=2','-C','panic=abort','-Z','emit-stack-sizes=yes','-C','link-arg='+object,path.join(link,'program.rs'),'-o',elf]);
    const elfSha256=hash(elf),result=imageProfile(elf,name==='qualified');
    const acceptance=publishAcceptedFinalSbfArtifact(elf,path.join(link,name+'-call-depth'),receipt=>{
      verifyFinalSbfArtifactReceipt(receipt,elf);assert.equal(hash(elf),elfSha256);assert.equal(receipt.artifact.sha256,elfSha256);
      return receipt;
    });
    images.push({name,elf,elfSha256,...result,callDepth:acceptance.result});
  }
  assert.throws(()=>imageProfile(images[0].elf,true),/required syscall import/);
  const originalElf=fs.readFileSync(images[1].elf),bytes=Buffer.from(originalElf);bytes[bytes.length-1]^=1;
  try {
    fs.writeFileSync(images[1].elf,bytes);
    assert.throws(()=>verifyFinalSbfArtifactReceipt(images[1].callDepth,images[1].elf));
  } finally {fs.writeFileSync(images[1].elf,originalElf);}
  verifyFinalSbfArtifactReceipt(images[1].callDepth,images[1].elf);
  const preparedRunner=prepareShaRunner(path.join(link,'runner'));
  const runnerControls=checkShaRunnerControls(preparedRunner,path.join(link,'runner-controls'));
  const runner=preparedRunner.receipt.executable.path;
  function requests(values:any[]) {
    verifyShaRunner(preparedRunner.receipt);
    const child=spawnSync(runner,[],{input:values.map(value=>JSON.stringify(value)).join('\n')+'\n',encoding:'utf8',timeout:240000,maxBuffer:32*1024*1024});
    assert.ifError(child.error);assert.equal(child.status,0,child.stderr);
    const responses=child.stdout.trim().split('\n').map(line=>JSON.parse(line));assert.equal(responses.length,values.length);
    verifyShaRunner(preparedRunner.receipt);
    return responses.map(response=>{assert(response.success,response.error);return response.value;});
  }
  const initial=[{op:'hello'},{op:'key',seed:141},{op:'key',seed:142}],keys=requests(initial);
  assert.equal(keys[0].runtime,'LiteSVM 0.7.1');
  const commands=[...initial];for(const [index,image] of images.entries())commands.push({op:'load',program:keys[index+1],elf:image.elf} as any);
  const indexes:any[]=[];
  for(const item of cases)for(const [index,image] of images.entries()) {
    indexes.push({name:image.name,case:item.name,index:commands.length,expected:item.expected,program:keys[index+1]});
    commands.push({op:'send',instructions:[...(packed?[{program:'ComputeBudget111111111111111111111111111111',accounts:[],data:[2,192,92,21,0]}]:[]),{program:keys[index+1],accounts:[],data:item.wire.slice(1)}]} as any);
  }
  const malformed=[...cases[0].wire.slice(1)];malformed[0]=255;
  for(const [index,image] of images.entries()) {
    indexes.push({name:image.name,case:'malformed-wire',index:commands.length,program:keys[index+1],error:104});
    commands.push({op:'send',instructions:[{program:keys[index+1],accounts:[],data:malformed}]} as any);
  }
  const responses=requests(commands),rows=indexes.map(item=>{
    const result=responses[item.index];
    if(item.error) {assert.equal(result.ok,false);assert.equal(result.code,item.error);}
    else {
      assert.equal(result.ok,true,JSON.stringify(result));const prefix='Program return: '+item.program+' ';
      const returns=result.logs.filter((line:string)=>line.startsWith(prefix));assert.equal(returns.length,1);
      assert.deepEqual([...Buffer.from(returns[0].slice(prefix.length),'base64')],item.expected,item.case+' '+item.name);
    }
    return {name:item.name,case:item.case,units:result.units,ok:result.ok};
  });
  const raw=path.join(runRoot,'execution.json');fs.writeFileSync(raw,JSON.stringify({commands,responses},null,2)+'\n');
  auditGeneration(manifest);auditGeneration(prior);
  for(const image of images){assert.equal(hash(image.elf),image.elfSha256);verifyFinalSbfArtifactReceipt(image.callDepth,image.elf);}
  for(const [file,digest] of Object.entries(before))assert.equal(hash(file),digest);
  verifyShaRunner(preparedRunner.receipt);
  const evidenceFiles=[harness,native,path.join(link,'program.rs'),path.join(link,'library.bindings.rs'),rust,readelf,runner,preparedRunner.file,runnerControls.file,
    ...Object.keys(preparedRunner.receipt.evidenceHashes),...Object.keys(preparedRunner.receipt.toolHashes)];
  const report={passed:true,endToEndVerified:false,id,sourceHashes:before,manifest:{file:active,sha256:hash(active)},
    runner:preparedRunner.receipt,
    runnerControls:runnerControls.report,
    evidenceHashes:Object.fromEntries(evidenceFiles.map(file=>[file,hash(file)])),
    controls,profile,nativeCases:cases.length,sbfCasesPerImage:cases.length+1,computeBudget:packed?1400000:200000,images,rows,logs,raw:{file:raw,sha256:hash(raw)},
    scope:'Actual command publication and failure retirement, ordinary host C under ASan/UBSan, two final linked image profiles and finite SHA/rejection oracle comparisons. SHA syscall, stable non-hostile filesystem, checked toolchain and runtime remain trusted; no universal SHA/compiler/rollback proof.'};
  const reportFile=path.join(runRoot,'report.json');fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
  fs.writeFileSync(latest,JSON.stringify({runRoot,reportSha256:hash(reportFile)},null,2)+'\n');
  console.log(JSON.stringify({passed:true,profile,controls:controls.length,nativeCases:cases.length,sbfCasesPerImage:cases.length+1,report:reportFile}));
} catch(error) {
  fs.writeFileSync(path.join(runRoot,'failure.json'),JSON.stringify({passed:false,error:String(error)},null,2)+'\n');throw error;
}

}
