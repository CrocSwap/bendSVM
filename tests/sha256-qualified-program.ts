import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {checkFinalSbfArtifact, verifyFinalSbfArtifactReceipt} from '../compiler/sbf-call-depth-artifact.ts';
import {compileQualifiedShaSbf} from '../scripts/build.ts';
import {wireCodec, type WireValue} from '../sdk/wire.ts';

type RunnerRequest = Record<string,unknown>;
type RunnerResponse = {success:boolean;value?:any;error?:string};
type RuntimeSchema = {types:{name:string;kind:string;variants?:{name:string;tag:number;fields:{name:string;type:string}[];cMaker:string}[]}[];
  exports:{name:string;args:string[];result:string}[]};

const root = path.resolve('.');
const fixture = 'tests/sha256-qualified-program/PROOF.bend';
const programRoot = 'program.process';
const work = path.resolve('build/sha256-qualified-program');
const qualifiedStem = path.join(work,'qualified');
const referenceStem = path.join(work,'ordinary-reference');
const runnerPath = path.resolve(process.env.SHA256_SHORT_SBF_RUNNER ??
  'scripts/test-runner/target/debug/bend-test-runner');
const runnerSha256 = 'ed30e400bcd46a0cf5da08a64f9810eb6b6ba932257154ff4ce98a4c724ce1bc';

function hash(file:string):string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function invoke(file:string,args:string[],options:Parameters<typeof spawnSync>[2]={}) {
  return spawnSync(file,args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024,...options});
}

function copyWorkingSources(destination:string):void {
  const listed=spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'});
  assert.equal(listed.status,0,`working source inventory succeeds: ${listed.stderr??''}`);
  for(const relative of listed.stdout.split('\0').filter(Boolean)) {
    const source=path.join(root,relative);
    const target=path.join(destination,relative);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    if(fs.lstatSync(source).isSymbolicLink())fs.symlinkSync(fs.readlinkSync(source),target);
    else fs.copyFileSync(source,target);
  }
}

function directories(directory:string):string[] {
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter(name=>fs.statSync(path.join(directory,name)).isDirectory())
    : [];
}

function buildInStage(stage:string,script:string,stem:string):{status:number|null;text:string} {
  const result=spawnSync(process.execPath,[script,fixture,programRoot,stem],{
    cwd:stage,encoding:'utf8',maxBuffer:32*1024*1024,env:process.env,
  });
  return {status:result.status,text:`${result.stdout??''}${result.stderr??''}`};
}

function testCommandPathElfSwap():Record<string,unknown> {
  const stage=fs.mkdtempSync(path.join(os.tmpdir(),'sha256-qualified-swap-'));
  try {
    copyWorkingSources(stage);
    fs.symlinkSync(path.join(root,'.deps'),path.join(stage,'.deps'));
    fs.symlinkSync(path.join(root,'node_modules'),path.join(stage,'node_modules'));
    const stem='build/sha256-qualified-swap/qualified';
    const ordinaryStem='build/sha256-qualified-swap/ordinary';
    const absoluteStem=path.join(stage,stem);
    fs.mkdirSync(path.dirname(absoluteStem),{recursive:true});
    fs.copyFileSync(`${qualifiedStem}.so`,`${absoluteStem}.so`);
    fs.copyFileSync(`${qualifiedStem}.manifest.json`,`${absoluteStem}.manifest.json`);
    const ordinaryElf=path.join(stage,`${ordinaryStem}.so`);
    fs.copyFileSync(`${referenceStem}.so`,ordinaryElf);
    const readelf=path.join(process.env.SBF_TOOLS??path.join(os.homedir(),'.cache/solana/v1.53/platform-tools/llvm/bin'),'llvm-readelf');
    const ordinarySymbols=spawnSync(readelf,['-s',ordinaryElf],{encoding:'utf8'});
    assert.equal(ordinarySymbols.status,0,`ordinary swap target has readable ELF symbols: ${ordinarySymbols.stderr??''}`);
    const ordinaryUndefined=[...new Set((ordinarySymbols.stdout??'').split('\n').filter(line=>/\bUND\b/.test(line))
      .map(line=>line.trim().split(/\s+/).at(-1)!).filter(symbol=>symbol!=='UND'))];
    assert(!ordinaryUndefined.includes('sol_sha256'),'ordinary swap target lacks required SHA syscall import');
    assert(!ordinaryUndefined.includes('abort'),'ordinary swap target lacks required abort import');
    const priorManifestBytes=fs.readFileSync(`${absoluteStem}.manifest.json`);
    const priorElfBytes=fs.readFileSync(`${absoluteStem}.so`);
    const priorManifest=JSON.parse(priorManifestBytes.toString('utf8'));
    assert.equal(priorManifest.buildRunId,qualifiedManifest.buildRunId,
      'prior evidence belongs to the current test run qualified build');
    const priorEvidence={buildRunId:priorManifest.buildRunId,manifestSha256:crypto.createHash('sha256').update(priorManifestBytes).digest('hex'),
      elfSha256:crypto.createHash('sha256').update(priorElfBytes).digest('hex')};
    const archiveRoot=path.join(path.dirname(absoluteStem),'sbf-call-depth-archive');
    const refusedRoot=path.join(path.dirname(absoluteStem),'sbf-call-depth-refused');
    const archivesBefore=new Set(directories(archiveRoot));
    const refusedBefore=new Set(directories(refusedRoot));
    const programScript=path.join(stage,'scripts/program.ts');
    const programSource=fs.readFileSync(programScript,'utf8');
    const compileMarker="    const {version,imports,stack,toolchain,elfSha256:checkedElfSha256} = compileQualifiedShaSbf(stem+'.c',stem);\n";
    assert.equal(programSource.split(compileMarker).length-1,1,'staged script has one qualified compile seam');
    fs.writeFileSync(programScript,programSource.replace(compileMarker,
      compileMarker+`    fs.copyFileSync(${JSON.stringify(`${ordinaryStem}.so`)},stem+'.so');\n`));
    const attack=buildInStage(stage,'scripts/build-sha256-program.ts',stem);
    assert.notEqual(attack.status,0,'command path rejects an ELF swap immediately after import/header checks');
    assert.match(attack.text,/Qualified SHA final ELF changed after SBPFv0 header\/import validation/,
      'command path reports a semantic checked-ELF identity refusal');
    assert.equal(fs.existsSync(`${absoluteStem}.so`),false,'failed command leaves no active ELF');
    assert.equal(fs.existsSync(`${absoluteStem}.manifest.json`),false,'failed command leaves no active manifest');
    assert.deepEqual(fs.readdirSync(path.dirname(absoluteStem)).filter(name=>name.startsWith('qualified.manifest.')&&name.endsWith('.tmp')),
      [],'failed command leaves no temporary manifest');
    const newArchives=directories(archiveRoot).filter(name=>!archivesBefore.has(name));
    const newRefusals=directories(refusedRoot).filter(name=>!refusedBefore.has(name));
    assert.equal(newArchives.length,1,'this failed run creates exactly one prior-evidence archive');
    assert.equal(newRefusals.length,1,'this failed run creates exactly one refused-artifact directory');
    const currentRunId=newArchives[0].slice('qualified-'.length);
    assert(currentRunId.length>0&&newRefusals[0]===`qualified-${currentRunId}`,
      'archive and refusal directories are both pinned to this build run identity');
    const archivedManifest=path.join(archiveRoot,newArchives[0],'qualified.manifest.json');
    const archivedElf=path.join(archiveRoot,newArchives[0],'qualified.so');
    assert.equal(hash(archivedManifest),priorEvidence.manifestSha256,'this run archive preserves the exact prior manifest hash');
    assert.equal(hash(archivedElf),priorEvidence.elfSha256,'this run archive preserves the exact prior ELF hash');
    assert.equal(JSON.parse(fs.readFileSync(archivedManifest,'utf8')).buildRunId,priorEvidence.buildRunId,
      'this run archive manifest retains the prior successful build identity');
    const refusedElf=path.join(refusedRoot,newRefusals[0],'qualified.so');
    assert.equal(hash(refusedElf),hash(ordinaryElf),'the rejected artifact is exactly the swapped ordinary ELF');
    return {currentRunId,diagnostic:attack.text.trim().split('\n').at(-1),
      priorEvidence,ordinaryElfSha256:hash(ordinaryElf),ordinaryMissingRequiredImports:['abort','sol_sha256'],
      archivedManifestSha256:hash(archivedManifest),archivedElfSha256:hash(archivedElf),refusedElfSha256:hash(refusedElf)};
  } finally {
    fs.rmSync(stage,{recursive:true,force:true});
  }
}

function runBuild(script:string,stem:string):{status:number|null;text:string} {
  const result=invoke(process.execPath,[script,fixture,programRoot,stem]);
  return {status:result.status,text:`${result.stdout??''}${result.stderr??''}`};
}

function executeRunner(requests:RunnerRequest[]):RunnerResponse[] {
  const input=`${requests.map(request=>JSON.stringify(request)).join('\n')}\n`;
  const result=invoke(runnerPath,[],{input,timeout:240_000});
  assert.equal(result.error,undefined,`pinned LiteSVM runner starts: ${result.error?.message??''}`);
  assert.equal(result.status,0,`pinned LiteSVM runner succeeds: ${result.stderr??''}`);
  const lines=(result.stdout??'').trimEnd().split('\n');
  assert.equal(lines.length,requests.length,'one runner response per request');
  return lines.map((line,index)=>{
    try {return JSON.parse(line) as RunnerResponse;}
    catch(error) {throw new Error(`runner response ${index} is invalid JSON: ${String(error)}`);}
  });
}

function valueAt(responses:RunnerResponse[],index:number,label:string):any {
  const response=responses[index];
  assert(response?.success,`${label}: ${response?.error??'runner error'}`);
  return response.value;
}

function typeBySuffix(schema:RuntimeSchema,suffix:string) {
  const matches=schema.types.filter(type=>type.name.endsWith(suffix));
  assert.equal(matches.length,1,`one emitted schema type ends with ${suffix}`);
  return matches[0];
}

function variantBySuffix(schema:RuntimeSchema,typeName:string,suffix:string) {
  const type=schema.types.find(item=>item.name===typeName);
  assert(type&&type.kind==='adt'&&type.variants,`${typeName} is an ADT`);
  const matches=type.variants.filter(variant=>variant.name===suffix||variant.name.endsWith(`.${suffix}`));
  assert.equal(matches.length,1,`one ${typeName} constructor ends with ${suffix}`);
  return matches[0];
}

function pairTree(schema:RuntimeSchema,typeName:string,leaves:number[],at=0):WireValue {
  const type=schema.types.find(item=>item.name===typeName);
  assert(type,`schema type exists: ${typeName}`);
  if(type.kind==='u32') {
    assert.equal(leaves.length,1,'one byte word per leaf');
    return leaves[at];
  }
  assert(type.kind==='adt'&&type.variants?.length===1,'pair node has one constructor');
  const variant=type.variants[0];
  assert.equal(variant.fields.length,2,'pair node has two children');
  const leafCount=(name:string):number=>{
    const child=schema.types.find(item=>item.name===name)!;
    if(child.kind==='u32')return 1;
    return child.variants![0].fields.reduce((sum,field)=>sum+leafCount(field.type),0);
  };
  const leftCount=leafCount(variant.fields[0].type);
  return {constructor:variant.name,fields:{
    [variant.fields[0].name]:pairTree(schema,variant.fields[0].type,leaves.slice(at,at+leftCount)),
    [variant.fields[1].name]:pairTree(schema,variant.fields[1].type,leaves.slice(at+leftCount)),
  }};
}

function messageValue(schema:RuntimeSchema,messageType:string,length:number,active:number[],inactive:number):WireValue {
  const message=variantBySuffix(schema,messageType,'Message');
  const bytesField=message.fields.find(field=>field.name==='bytes')!;
  const bytesType=schema.types.find(type=>type.name===bytesField.type)!;
  const bytesVariant=variantBySuffix(schema,bytesField.type,'Bytes64');
  const wordsField=bytesVariant.fields.find(field=>field.name==='words')!;
  const slots=Array<number>(64).fill(inactive);
  active.forEach((byte,index)=>slots[index]=byte);
  return {constructor:message.name,fields:{
    length,
    bytes:{constructor:bytesVariant.name,fields:{words:pairTree(schema,wordsField.type,slots)}},
  }};
}

function resultWire(schema:RuntimeSchema,stateType:string,bytes:Buffer|undefined):WireValue {
  const rejected=variantBySuffix(schema,stateType,'Rejected');
  if(!bytes)return {constructor:rejected.name,fields:{}};
  const hashed=variantBySuffix(schema,stateType,'Hashed');
  const digestField=hashed.fields.find(field=>field.name==='digest')!;
  const digestType=schema.types.find(type=>type.name===digestField.type)!;
  const digestVariant=variantBySuffix(schema,digestField.type,'Digest256');
  const words=Object.fromEntries(digestVariant.fields.map((field,index)=>[
    field.name,bytes.readUInt32BE(index*4),
  ]));
  return {constructor:hashed.name,fields:{digest:{constructor:digestVariant.name,fields:words}}};
}

function makeCases(schema:RuntimeSchema,messageType:string,stateType:string) {
  const cases:{name:string;length:number;active:number[];inactive:number;digest?:Buffer}[]=[];
  for(let length=0;length<=55;length++) {
    const active=Array.from({length},(_,index)=>(0x80+index*37+length*11)&255);
    if(length===1)active[0]=0x80;
    if(length===55)active[54]=0xff;
    cases.push({name:`length-${length}`,length,active,inactive:(0xa5000000|(length<<8)|length)>>>0});
  }
  cases.push(
    {name:'high-bytes-128-through-255',length:55,active:Array.from({length:55},(_,i)=>128+((i*17)%128)),inactive:0xffffffff},
    {name:'reject-length-56',length:56,active:Array.from({length:56},(_,i)=>i*3&255),inactive:0xffffffff},
    {name:'reject-length-64',length:64,active:Array.from({length:64},(_,i)=>255-i),inactive:0xffffffff},
    {name:'reject-length-u32-max',length:0xffffffff,active:[],inactive:0xffffffff},
    {name:'reject-active-256-first',length:1,active:[256],inactive:0xffffffff},
    {name:'reject-active-256-last',length:55,active:[...Array.from({length:54},(_,i)=>i),256],inactive:0xffffffff},
    {name:'reject-active-u32-max-first',length:1,active:[0xffffffff],inactive:0xdeadbeef},
    {name:'reject-active-u32-max-last',length:55,active:[...Array.from({length:54},(_,i)=>i),0xffffffff],inactive:0xdeadbeef},
  );
  const codec=wireCodec(schema);
  return cases.map(item=>{
    const message=messageValue(schema,messageType,item.length,item.active,item.inactive);
    const valid=item.length<=55&&item.active.length===item.length&&item.active.every(byte=>byte<=255);
    const digest=valid?crypto.createHash('sha256').update(Buffer.from(item.active)).digest():undefined;
    const encoded=codec.encode(messageType,message);
    return {...item,digest,wire:[1,...encoded],expected:[...codec.encode(stateType,resultWire(schema,stateType,digest))]};
  });
}

function programInstruction(program:string,state:string,actor:string,data:number[],initializing=false) {
  return {program,accounts:[
    {address:state,signer:initializing,writable:true},
    {address:actor,signer:false,writable:false},
  ],data};
}

fs.mkdirSync(work,{recursive:true});
assert(fs.existsSync(runnerPath),`prebuilt LiteSVM runner exists: ${runnerPath}`);
assert.equal(hash(runnerPath),runnerSha256,'existing main LiteSVM runner has the exact pinned SHA-256');

const qualified=runBuild('scripts/build-sha256-program.ts',qualifiedStem);
assert.equal(qualified.status,0,`explicit qualified SHA build succeeds:\n${qualified.text}`);
const ordinary=runBuild('scripts/program.ts',referenceStem);
assert.equal(ordinary.status,0,`ordinary source build succeeds:\n${ordinary.text}`);

const qualifiedManifest=JSON.parse(fs.readFileSync(`${qualifiedStem}.manifest.json`,'utf8'));
const ordinaryManifest=JSON.parse(fs.readFileSync(`${referenceStem}.manifest.json`,'utf8'));
assert(qualifiedManifest.qualifiedSha256,'opt-in final manifest contains internal qualification receipt');
assert(!ordinaryManifest.qualifiedSha256,'ordinary build has no SHA qualification marker');
assert(qualifiedManifest.qualifiedSha256.receipt.originalEmission.taggedSumEvidenceScope==='originalC only');
assert.equal(qualifiedManifest.qualifiedSha256.receiptSha256,
  crypto.createHash('sha256').update(JSON.stringify(qualifiedManifest.qualifiedSha256.receipt)).digest('hex'));
assert.equal(qualifiedManifest.elfSha256,hash(`${qualifiedStem}.so`));
assert.equal(qualifiedManifest.generated['qualified.h'],hash(`${qualifiedStem}.h`));
assert.deepEqual(qualifiedManifest.imports.filter((name:string)=>['abort','sol_sha256','sol_log_64_'].includes(name)).sort(),
  ['abort','sol_sha256']);
assert(qualifiedManifest.stack.maxFrameBytes<=4096,'qualified live C stack report is within the 4096-byte bound');
assert(qualifiedManifest.sbfCallDepth.analysis.longestFrameCount>0,'final ELF has accepted call-depth evidence');
assert.equal(ordinaryManifest.imports,undefined,'ordinary build manifest retains its ordinary shape');
const readelf=path.join(process.env.SBF_TOOLS??path.join(os.homedir(),'.cache/solana/v1.53/platform-tools/llvm/bin'),'llvm-readelf');
const ordinarySymbols=invoke(readelf,['-s',`${referenceStem}.so`]);
assert.equal(ordinarySymbols.status,0,'ordinary ELF symbol inspection succeeds');
assert.doesNotMatch(ordinarySymbols.stdout??'',/\bUND\b[^\n]*\bsol_sha256\b/,'ordinary non-opt-in ELF has no SHA syscall import');
const commandPathElfSwap=testCommandPathElfSwap();

const profileProbes=[
  {name:'missing-abort',source:`typedef unsigned char u8; typedef unsigned int u32; typedef unsigned long long u64;\nextern u64 sol_sha256(const u8 *,u64,u8 *);\nu64 entrypoint(const u8 *p){u8 out[32]={0};return sol_sha256(p,1,out);}\n`,error:/missing required final ELF import: abort/},
  {name:'missing-sha',source:`typedef unsigned char u8; typedef unsigned int u32; typedef unsigned long long u64;\nextern void abort(void);\nu64 entrypoint(const u8 *p){if(p[0])abort();return 0;}\n`,error:/missing required final ELF import: sol_sha256/},
  {name:'forbidden-observer',source:`typedef unsigned char u8; typedef unsigned int u32; typedef unsigned long long u64;\nextern u64 sol_sha256(const u8 *,u64,u8 *); extern u64 sol_log_64_(u64,u64,u64,u64,u64); extern void abort(void);\nu64 entrypoint(const u8 *p){u8 out[32]={0};u64 x=sol_sha256(p,1,out);sol_log_64_(x,0,0,0,0);if(p[0]==255)abort();return x+out[0];}\n`,error:/forbids test observation import sol_log_64_/},
];
const importProfileRefusals:{name:string;diagnostic:string;artifacts:Record<string,string>}[]=[];
for(const probe of profileProbes) {
  const probeSource=path.join(work,`${probe.name}.c`);
  const probeStem=path.join(work,probe.name);
  fs.writeFileSync(probeSource,probe.source);
  let refusal:unknown;
  try {compileQualifiedShaSbf(probeSource,probeStem);} catch(error) {refusal=error;}
  assert(refusal instanceof Error,`${probe.name} is refused by the fixed qualified-SHA import profile`);
  assert.match(refusal.message,probe.error,`${probe.name} refusal retains its semantic diagnostic`);
  const quarantine=path.join(work,'import-profile-refused',probe.name);
  fs.mkdirSync(quarantine,{recursive:true});
  const artifacts:Record<string,string>={};
  for(const suffix of ['.c','.o','.so','.su','.memory.o','.memory.su','.stack.json']) {
    const generated=probeStem+suffix;
    if(!fs.existsSync(generated))continue;
    const archived=path.join(quarantine,path.basename(generated));
    fs.renameSync(generated,archived);
    artifacts[path.basename(archived)]=hash(archived);
  }
  importProfileRefusals.push({name:probe.name,diagnostic:refusal.message,artifacts});
}

const schema=JSON.parse(fs.readFileSync(`${qualifiedStem}.schema.json`,'utf8')) as RuntimeSchema;
const layout=JSON.parse(fs.readFileSync(`${qualifiedStem}.interface.json`,'utf8')) as {
  state:string;instruction:string;header:number[];stateBytes:number;
};
const cases=makeCases(schema,layout.instruction,layout.state);
assert.deepEqual(cases.slice(0,56).map(item=>item.length),Array.from({length:56},(_,i)=>i),
  'actual final ELF cases cover every valid short length 0 through 55');
assert(cases.some(item=>item.active.some(byte=>byte>=128)),'valid messages include high-valued bytes');
assert(cases.slice(0,56).every(item=>item.inactive>255),'valid cases poison inactive slots with non-byte values');

const programSeeds={qualifiedProgram:41,referenceProgram:42,qualifiedState:43,referenceState:44,qualifiedActor:45,referenceActor:46};
const requests:RunnerRequest[]=[{op:'hello'},...Object.entries(programSeeds).map(([label,seed])=>({op:'key',seed,label}))];
const keyIndex=new Map(Object.keys(programSeeds).map((name,index)=>[name,index+1]));
const addresses:Record<string,string>={};
for(const [name,index] of keyIndex) addresses[name]=`$response:${index}`;
const loads:{name:'qualified'|'reference';programKey:keyof typeof programSeeds;elf:string}[]=[
  {name:'qualified',programKey:'qualifiedProgram',elf:`${qualifiedStem}.so`},
  {name:'reference',programKey:'referenceProgram',elf:`${referenceStem}.so`},
];
for(const item of loads)requests.push({op:'load',program:'$'+item.programKey,elf:path.resolve(item.elf)});
for(const item of loads) {
  const isQualified=item.name==='qualified';
  const programKey=isQualified?'qualifiedProgram':'referenceProgram';
  const stateKey=isQualified?'qualifiedState':'referenceState';
  const actorKey=isQualified?'qualifiedActor':'referenceActor';
  const empty=[0,...cases[0].wire.slice(1)];
  requests.push({op:'create',allocations:[{address:'$'+stateKey,bytes:layout.stateBytes,owner:'$'+programKey}],
    instructions:[programInstruction('$'+programKey,'$'+stateKey,'$'+actorKey,empty,true)]});
}
const caseRequestIndexes:{caseName:string;qualifiedSend:number;qualifiedAccount:number;referenceSend:number;referenceAccount:number}[]=[];
for(const item of cases) {
  const indices={} as {caseName:string;qualifiedSend:number;qualifiedAccount:number;referenceSend:number;referenceAccount:number};
  indices.caseName=item.name;
  for(const name of ['qualified','reference'] as const) {
    const program=name==='qualified'?'qualifiedProgram':'referenceProgram';
    const state=name==='qualified'?'qualifiedState':'referenceState';
    const actor=name==='qualified'?'qualifiedActor':'referenceActor';
    const sendIndex=requests.length;
    requests.push({op:'send',instructions:[programInstruction('$'+program,'$'+state,'$'+actor,item.wire,false)]});
    const accountIndex=requests.length;
    requests.push({op:'account',address:'$'+state});
    indices[name==='qualified'?'qualifiedSend':'referenceSend']=sendIndex;
    indices[name==='qualified'?'qualifiedAccount':'referenceAccount']=accountIndex;
  }
  caseRequestIndexes.push(indices);
}
assert(requests.length<=384,`bounded LiteSVM runner request count ${requests.length} <= 384`);

// Fill symbolic addresses after the deterministic runner key replies are read.
const keyRequests=requests.slice(0,7);
const keyResponses=executeRunner(keyRequests);
assert.equal(valueAt(keyResponses,0,'runner hello').runtime,'LiteSVM 0.7.1');
for(const [name,index] of keyIndex)addresses[name]=valueAt(keyResponses,index,`runner key ${name}`);
const resolveRequest=(request:RunnerRequest):RunnerRequest=>JSON.parse(JSON.stringify(request,(_key,value)=>
  typeof value==='string'&&value.startsWith('$')?addresses[value.slice(1) as keyof typeof addresses]:value));
const executionRequests=requests.map(resolveRequest);
const responses=executeRunner(executionRequests);
const runnerVersion=valueAt(responses,0,'runner hello');
assert.equal(runnerVersion.runtime,'LiteSVM 0.7.1','pinned LiteSVM runner version');
for(const [position,item] of loads.entries()) {
  const loaded=valueAt(responses,7+position,`load ${item.name} final ELF`);
  assert.equal(loaded,null,`${item.name} final ELF loaded in LiteSVM`);
}
for(let index=0;index<2;index++) {
  const created=valueAt(responses,9+index,`initialize ${index}`);
  assert.equal(created.ok,true,`program account state initialized: ${created.error??''}`);
  assert(Number.isSafeInteger(created.units)&&created.units>0,'initialization reports LiteSVM compute units');
}

let qualifiedMaxCu=0,referenceMaxCu=0;
for(const item of caseRequestIndexes) {
  const spec=cases.find(testCase=>testCase.name===item.caseName)!;
  const qualifiedSend=valueAt(responses,item.qualifiedSend,'qualified SHA transaction');
  const referenceSend=valueAt(responses,item.referenceSend,'ordinary reference transaction');
  assert.equal(qualifiedSend.ok,true,`${spec.name} qualified SHA transaction succeeds: ${qualifiedSend.error??''}`);
  assert.equal(referenceSend.ok,true,`${spec.name} ordinary reference transaction succeeds: ${referenceSend.error??''}`);
  assert(Number.isSafeInteger(qualifiedSend.units)&&qualifiedSend.units>0,`${spec.name} qualified compute units`);
  assert(Number.isSafeInteger(referenceSend.units)&&referenceSend.units>0,`${spec.name} reference compute units`);
  qualifiedMaxCu=Math.max(qualifiedMaxCu,qualifiedSend.units);
  referenceMaxCu=Math.max(referenceMaxCu,referenceSend.units);
  const qualifiedAccount=valueAt(responses,item.qualifiedAccount,`${spec.name} qualified state`);
  const referenceAccount=valueAt(responses,item.referenceAccount,`${spec.name} reference state`);
  assert(qualifiedAccount&&referenceAccount,'both program state accounts remain present');
  assert.equal(qualifiedAccount.owner,addresses.qualifiedProgram,'qualified state owner');
  assert.equal(referenceAccount.owner,addresses.referenceProgram,'reference state owner');
  const resultLength=wireCodec(schema).sizes.get(layout.state)!;
  const qualifiedResult=qualifiedAccount.data.slice(layout.header.length,layout.header.length+resultLength);
  const referenceResult=referenceAccount.data.slice(layout.header.length,layout.header.length+resultLength);
  assert.deepEqual(qualifiedResult,spec.expected,`${spec.name} qualified output matches Node SHA/rejection encoding`);
  assert.deepEqual(referenceResult,spec.expected,`${spec.name} checked Bend reference agrees independently`);
  assert.deepEqual(qualifiedResult,referenceResult,`${spec.name} qualified and checked-reference final ELFs agree`);
}

const qualifiedReceipt=qualifiedManifest.sbfCallDepth;
const tampered=fs.readFileSync(`${qualifiedStem}.so`);
try {
  const bad=Buffer.from(tampered);bad[0]^=0xff;fs.writeFileSync(`${qualifiedStem}.so`,bad);
  assert.throws(()=>verifyFinalSbfArtifactReceipt(qualifiedReceipt,`${qualifiedStem}.so`),
    /SBF_CALL_DEPTH_ELF_HASH_MISMATCH/,'accepted receipt refuses a changed final ELF hash');
  assert.throws(()=>checkFinalSbfArtifact(`${qualifiedStem}.so`,path.join(work,'tamper-reports')),
    /SBF_CALL_DEPTH_(?:REFUSED|UNSUPPORTED_PROFILE)/,'tampered final ELF is refused by the final-artifact gate');
} finally {
  fs.writeFileSync(`${qualifiedStem}.so`,tampered);
}
assert.equal(hash(`${qualifiedStem}.so`),qualifiedReceipt.artifact.sha256,'restore exact final ELF after tampering probe');

// A proof-gate failure after a successful publication must archive prior
// evidence and leave neither stale active ELF nor a success manifest.
const proofPath=path.resolve(fixture);
const archiveRoot=path.join(work,'sbf-call-depth-archive');
const proofPriorEvidence={buildRunId:qualifiedManifest.buildRunId,manifestSha256:hash(`${qualifiedStem}.manifest.json`),
  elfSha256:hash(`${qualifiedStem}.so`)};
const archivesBeforeProofFailure=new Set(directories(archiveRoot));
const originalProof=fs.readFileSync(proofPath);
try {
  const changed='import ./program.bend as Program\n';
  assert.notEqual(changed,originalProof.toString('utf8'),'proof mutation removes adjacent laws and proof terms');
  fs.writeFileSync(proofPath,changed);
  const rejected=runBuild('scripts/build-sha256-program.ts',qualifiedStem);
  assert.notEqual(rejected.status,0,'explicit path rejects missing adjacent laws');
  assert.match(rejected.text,/must import the adjacent LAWS\.bend/);
} finally {
  fs.writeFileSync(proofPath,originalProof);
}
assert.equal(fs.existsSync(`${qualifiedStem}.so`),false,'failed qualification leaves no stale active ELF');
assert.equal(fs.existsSync(`${qualifiedStem}.manifest.json`),false,'failed qualification leaves no stale success manifest');
const newProofArchives=directories(archiveRoot).filter(name=>!archivesBeforeProofFailure.has(name));
assert.equal(newProofArchives.length,1,'this proof-gate run creates exactly one prior-evidence archive');
const proofArchive=path.join(archiveRoot,newProofArchives[0]);
const proofArchiveRunId=newProofArchives[0].slice('qualified-'.length);
assert(proofArchiveRunId.length>0&&proofArchiveRunId!==proofPriorEvidence.buildRunId,
  'proof-gate archive is named for this failed build run, not the prior success');
assert.equal(hash(path.join(proofArchive,'qualified.so')),proofPriorEvidence.elfSha256,
  'this proof-gate run archives the exact prior successful ELF');
assert.equal(hash(path.join(proofArchive,'qualified.manifest.json')),proofPriorEvidence.manifestSha256,
  'this proof-gate run archives the exact prior successful manifest');
assert.equal(JSON.parse(fs.readFileSync(path.join(proofArchive,'qualified.manifest.json'),'utf8')).buildRunId,
  proofPriorEvidence.buildRunId,'archived proof-gate manifest retains its prior-success identity');

const report={schemaVersion:1,passed:true,runner:{path:runnerPath,sha256:runnerSha256,runtime:runnerVersion.runtime},
  build:{qualifiedElfSha256:qualifiedManifest.elfSha256,qualifiedCHeaderSha256:hash(`${qualifiedStem}.h`),
    ordinaryElfSha256:ordinaryManifest.elfSha256,qualificationReceiptSha256:qualifiedManifest.qualifiedSha256.receiptSha256,
    imports:qualifiedManifest.imports,stackMaxFrameBytes:qualifiedManifest.stack.maxFrameBytes,
    callDepth:qualifiedManifest.sbfCallDepth.analysis},
  execution:{cases:cases.length,validLengths:'0..55',maxQualifiedComputeUnits:qualifiedMaxCu,
    maxReferenceComputeUnits:referenceMaxCu,independentNodeCrypto:true,checkedBendReference:true,
    activeByteAndLengthRejections:true,inactiveBytePoison:true},
  refusals:{tamperedFinalElf:true,proofGateAfterPriorSuccess:true,staleActiveArtifact:false,
    commandPathElfSwap,proofGateArchive:{runId:proofArchiveRunId,...proofPriorEvidence},importProfiles:importProfileRefusals},
};
fs.writeFileSync(path.join(work,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(`Qualified SHA production build passed: ${cases.length} final-ELF cases, max CU ${qualifiedMaxCu}, stack ${report.build.stackMaxFrameBytes}/4096, call depth ${qualifiedReceipt.analysis.longestFrameCount}; evidence ${path.relative(root,path.join(work,'report.json'))}`);
