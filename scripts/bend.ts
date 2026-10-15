import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {prepareBend} from './build.ts';

export const repository=path.resolve(import.meta.dir,'..');
export const LOCAL_RPC_ENDPOINT='http://127.0.0.1:18899';
export type ProjectTarget='fogo'|'solana';
/**
 * Network targets, both on platform-tools v1.57: fogo -> SBPFv0, solana -> SBPFv3.
 * A project without "targets" keeps the historical single v1.53 SBPFv0 output.
 */
export const PROJECT_TARGETS:Record<ProjectTarget,{program:'fogo-v0'|'solana-v3';runner:'classic'|'modern';description:string}>={
  fogo:{program:'fogo-v0',runner:'classic',description:'SBPFv0 for Fogo (platform-tools v1.57, LiteSVM 0.7.1)'},
  solana:{program:'solana-v3',runner:'modern',description:'SBPFv3 for Solana (platform-tools v1.57, LiteSVM 0.13.0)'},
};
export type Project={version:1;source:string;root:string;layout:string|null;output:string;targets?:ProjectTarget[]};
export type ProjectOptions={localRpc?:string;target?:ProjectTarget};
export function loadProject(directory:string) {
  const dir=path.resolve(directory),file=path.join(dir,'bend.json');
  if(!fs.existsSync(file))throw new Error(`No bend.json in ${dir}. Create a project with: npm run bend -- new <directory>`);
  const config=JSON.parse(fs.readFileSync(file,'utf8')) as Project;
  const keys=Object.keys(config).filter(key=>key!=='targets').sort().join(',');
  if(config.targets!==undefined&&(!Array.isArray(config.targets)||config.targets.length===0||
      new Set(config.targets).size!==config.targets.length||config.targets.some(t=>!Object.hasOwn(PROJECT_TARGETS,t))))
    throw new Error(`Invalid bend.json targets: expected a non-empty list of distinct names from ${Object.keys(PROJECT_TARGETS).join(', ')}`);
  if(config.version!==1||keys!=='layout,output,root,source,version'||
      [config.source,config.root,config.output].some(v=>typeof v!=='string'||!v.trim())||
      (config.layout!==null&&(typeof config.layout!=='string'||!config.layout.trim())))throw new Error('Invalid bend.json: expected version, source, root, layout (path or null) and output');
  for(const value of [config.source,...(config.layout?[config.layout]:[]),config.output]) {
    const relative=path.relative(dir,path.resolve(dir,value));
    if(relative==='..'||relative.startsWith('../')||path.isAbsolute(relative))throw new Error('Project source, layout and output paths must stay inside the project');
  }
  const stem=path.resolve(dir,config.output);
  return {dir,config,source:path.resolve(dir,config.source),layout:config.layout?path.resolve(dir,config.layout):undefined,stem,
    targets:config.targets as ProjectTarget[]|undefined};
}
/** Per-target output stem: <output-dir>/<target>/<output-name>. */
export function targetStem(stem:string,target:ProjectTarget){return path.join(path.dirname(stem),target,path.basename(stem));}
function selectedTargets(project:ReturnType<typeof loadProject>,options:ProjectOptions):(ProjectTarget|undefined)[] {
  if(!project.targets){
    if(options.target)throw new Error('--target requires "targets" in bend.json');
    return [undefined];
  }
  if(options.target&&!project.targets.includes(options.target))
    throw new Error(`Target ${options.target} is not listed in bend.json targets (${project.targets.join(', ')})`);
  return options.target?[options.target]:project.targets;
}
/** Build one target, translating toolchain failures into an actionable message. */
async function buildTarget(project:ReturnType<typeof loadProject>,target:ProjectTarget|undefined) {
  const {buildProgram}=await import('./program.ts');
  const stem=target?targetStem(project.stem,target):project.stem;
  try {
    return {stem,manifest:await buildProgram(project.source,project.config.root,stem,project.layout,target?PROJECT_TARGETS[target].program:undefined)};
  }catch(e){
    const message=e instanceof Error?e.message:String(e);
    if(target&&/platform-tools|pinned for macOS|content pin|ENOENT|Cannot locate|spawn/.test(message))
      throw new Error(`Target ${target} needs Anza platform-tools v1.57 (macOS arm64, Linux x86_64 or Linux aarch64). `+
        `Install it with: npm run install:platform-tools (default ~/.cache/solana/v1.57/platform-tools; override with SBF_V157_TOOLS).\n${message}`);
    throw e;
  }
}
/** The generated client is target-independent; publish it once at the base stem. */
function publishSharedClient(project:ReturnType<typeof loadProject>,stems:string[],suffixes:readonly string[]) {
  for(const suffix of suffixes){
    const [first,...rest]=stems.map(stem=>fs.readFileSync(stem+suffix));
    for(const other of rest)if(!first.equals(other))throw new Error(`Generated client ${suffix} differs between targets`);
    fs.mkdirSync(path.dirname(project.stem),{recursive:true});
    fs.writeFileSync(project.stem+suffix,first);
  }
}
/** Targets written by `bend new`; `new --target <name>` writes just that one. */
export const DEFAULT_TARGETS:ProjectTarget[]=['fogo','solana'];
export function createProject(destination:string,targets:ProjectTarget[]=DEFAULT_TARGETS) {
  const dir=path.resolve(destination);
  if(fs.existsSync(dir))throw new Error(`Refusing to overwrite existing path: ${dir}`);
  fs.mkdirSync(path.dirname(dir),{recursive:true});
  const staging=fs.mkdtempSync(path.join(path.dirname(dir),'.bend-new-'));
  try {
    let sdk=path.relative(dir,path.join(repository,'sdk')).split(path.sep).join('/');
    if(!sdk.startsWith('.'))sdk='./'+sdk;
    for(const name of fs.readdirSync(path.join(repository,'templates/collection'))){
      const quotedDirectory="'"+dir.replaceAll("'","'\\''")+"'";
      const source=fs.readFileSync(path.join(repository,'templates/collection',name),'utf8').replaceAll('@SDK@',sdk).replaceAll('@PROJECT@',quotedDirectory);
      fs.writeFileSync(path.join(staging,name),source);
    }
    fs.writeFileSync(path.join(staging,'bend.json'),JSON.stringify({version:1,source:'PROOF.bend',root:'program.process',layout:'storage.json',output:'dist/program',targets},null,2)+'\n');
    fs.writeFileSync(path.join(staging,'.gitignore'),'dist/\n');
    fs.renameSync(staging,dir);
  }catch(e){fs.rmSync(staging,{recursive:true,force:true});throw e;}
  return dir;
}
function sha256(file:string) {return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function localRunDirectory() {
  fs.mkdirSync(path.join(repository,'build'),{recursive:true});
  const name=`local-test-${Date.now()}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  return path.join(repository,'build',name);
}
export function invalidateTestSuccess(project:ReturnType<typeof loadProject>,localRpc?:string) {
  const report=project.stem+(localRpc?'.local-test-report.json':'.test-report.json');
  fs.rmSync(report,{force:true});
  return report;
}
function localReportHashes(project:ReturnType<typeof loadProject>,testFile:string,runner:string) {
  const manifestFile=project.stem+'.manifest.json';
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8')) as {inputs?:Record<string,string>};
  const client=['.client.ts','.client.js','.client-runtime.js','.client-runtime.d.ts'].map(suffix=>project.stem+suffix);
  const runnerInputs=['scripts/bend.ts','sdk/testing.ts','sdk/program-client.ts',
    'scripts/local-runner/Cargo.toml','scripts/local-runner/Cargo.lock','scripts/local-runner/src/main.rs',runner];
  const sourceInputs=Object.keys(manifest.inputs??{});
  const files=[testFile,path.join(project.dir,'bend.json'),...(project.layout?[project.layout]:[]),
    ...sourceInputs,manifestFile,project.stem+'.so',...client,...runnerInputs];
  const unique=[...new Set(files.map(file=>path.resolve(file)))];
  const hashes=Object.fromEntries(unique.map(file=>[path.relative(repository,file),sha256(file)]));
  return {hashes,sourceManifestSha256:sha256(manifestFile),elfSha256:sha256(project.stem+'.so')};
}
async function testTarget(project:ReturnType<typeof loadProject>,target:ProjectTarget|undefined,
    run:(t:any)=>Promise<void>,testFile:string,options:ProjectOptions) {
  const testing=await import('../sdk/testing.ts');
  const runnerKind=target?PROJECT_TARGETS[target].runner:'classic';
  const runnerSpec=testing.TEST_RUNNERS[runnerKind];
  const label=target?`[${target}] `:'';
  const localRun=options.localRpc?localRunDirectory():undefined;
  const t=options.localRpc
    ?await testing.startLocalRpcTestProgram(project.stem+'.so',options.localRpc,localRun!)
    :await testing.startTestProgram(project.stem+'.so',runnerKind);
  try {
    await run(t);
    const summary=t.summary();
    if(!summary.programCalls||!summary.assertions)throw new Error('Tests must invoke this SBF program and assert their results');
    await t.close();
    const runner=options.localRpc?'target/local-runner/debug/bend-local-runner':runnerSpec.executable;
    let report:Record<string,unknown>;
    if(options.localRpc) {
      const evidence=t.localEvidence;
      if(!evidence)throw new Error('Local RPC runner did not produce completed run evidence');
      const inputs=localReportHashes(project,testFile,runner);
      report={version:1,passed:true,backend:'local-rpc',...(target?{target}:{}),endpoint:evidence.endpoint,
        runtime:evidence.runtime,validatorVersion:evidence.version,genesisHash:evidence.genesisHash,
        payer:t.payer,program:evidence.program,deploymentSignature:evidence.deploymentSignature,
        byteMatch:{matchedBytes:evidence.elfBytesMatched,deployedBytes:evidence.elfBytes,zeroPaddingBytes:evidence.zeroPaddingBytes},
        runDirectory:evidence.directory,receiptPath:evidence.receiptsPath,signatures:evidence.signatures,
        ...summary,testReceipts:t.receipts,...inputs};
      fs.writeFileSync(project.stem+'.local-test-report.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
      fs.chmodSync(project.stem+'.local-test-report.json',0o600);
    } else {
      const runnerDir=path.dirname(runnerSpec.manifest);
      const files=[testFile,path.join(project.dir,'bend.json'),project.stem+'.manifest.json','scripts/bend.ts','sdk/testing.ts',
        runnerSpec.manifest,path.join(runnerDir,'Cargo.lock'),path.join(runnerDir,'src/main.rs'),runner];
      report={passed:true,...(target?{target}:{}),...summary,receipts:t.receipts,hashes:Object.fromEntries(files.map(file=>[path.relative(repository,file),sha256(file)]))};
      fs.writeFileSync(project.stem+'.test-report.json',JSON.stringify(report,null,2)+'\n');
    }
    console.log(`${target?`${label}on ${summary.runtime}: `:''}SBF tests passed: ${summary.successful} successful transactions, ${summary.rejected} expected rejections, ${summary.assertions} assertions`);
    return report;
  }catch(e){await t.close().catch(()=>{});throw e;}
}
export async function projectCommand(command:string,directory:string,options:ProjectOptions={}) {
  const project=loadProject(directory);
  if(options.localRpc!==undefined&&options.localRpc!==LOCAL_RPC_ENDPOINT)throw new Error(`Local RPC testing accepts only ${LOCAL_RPC_ENDPOINT}`);
  const targets=selectedTargets(project,options);
  if(options.localRpc&&targets.length>1)throw new Error('Local RPC testing runs one target; add --target fogo or --target solana');
  if(command==='test')for(const target of targets)invalidateTestSuccess(target?{...project,stem:targetStem(project.stem,target)}:project,options.localRpc);
  process.chdir(repository);
  prepareBend();
  if(command==='build'||command==='test'){
    const built=[];
    for(const target of targets){
      if(target)console.log(`[${target}] ${PROJECT_TARGETS[target].description}`);
      built.push({target,...await buildTarget(project,target)});
    }
    if(project.targets){
      const {clientSuffixes}=await import('../compiler/client-artifacts.ts');
      publishSharedClient(project,built.map(entry=>entry.stem),clientSuffixes);
    }
    if(command==='build')return project.targets?Object.fromEntries(built.map(entry=>[entry.target,entry.manifest])):built[0].manifest;
    const testFile=path.join(project.dir,'test.ts');
    if(!fs.existsSync(testFile))throw new Error('Project has no test.ts. Export an async function accepting the SBF test context.');
    const test=await import(testFile);
    if(typeof test.default!=='function')throw new Error('test.ts must export a default test function');
    const reports:Record<string,Record<string,unknown>>={};
    for(const entry of built)reports[entry.target??'default']=await testTarget({...project,stem:entry.stem},entry.target,test.default,testFile,options);
    return project.targets?reports:reports.default;
  }
  const {checkedProgram,Backend}=await import('../compiler/backend.ts');
  const checked=await checkedProgram(project.source);
  if(command==='verify'){
    console.log('Declared source laws and dependencies checked. This is not an automatic SMT or compiled-binary proof.');return;
  }
  if(command==='check'){
    const layout=project.layout?JSON.parse(fs.readFileSync(project.layout,'utf8')):undefined;
    const roots=[...new Set([project.config.root,...(layout?.collection?[layout.collection.select]:[])])];
    const emitted=new Backend(checked.book).emit(roots);
    const {emitStorage}=await import('../compiler/storage.ts');
    const {programClient}=await import('../sdk/program-client.ts');
    const adapter=emitStorage(emitted.schema,project.config.root,layout);
    programClient(emitted.schema,adapter.interface as any,'11111111111111111111111111111111');
    console.log('Source laws, SBF subset, storage layout and client compatibility checked. Build also checks compiled stack limits.');return;
  }
  throw new Error(`Unknown command: ${command}`);
}
if(import.meta.main){
  try {
    const {command,directory,options}=parseBendArgs(process.argv.slice(2));
    if(command==='new')console.log(`Created ${createProject(directory,options.target?[options.target]:DEFAULT_TARGETS)}`);
    else await projectCommand(command,path.resolve(directory),options);
  }catch(e){console.error(e instanceof Error?e.message:String(e));process.exitCode=1;}
}
export function parseBendArgs(args:string[]):{command:string;directory:string;options:ProjectOptions} {
  const usage='Usage: npm run bend -- <new|check|verify|build|test> <project-directory> [--target fogo|solana] [--local-rpc http://127.0.0.1:18899]';
  const [command,directory,...extra]=args;
  if(!command||!directory||!['new','check','verify','build','test'].includes(command))throw new Error(usage);
  let localRpc:string|undefined,target:ProjectTarget|undefined;
  for(let index=0;index<extra.length;index++){
    const arg=extra[index];
    const [flag,inline]=arg.startsWith('--')&&arg.includes('=')?[arg.slice(0,arg.indexOf('=')),arg.slice(arg.indexOf('=')+1)]:[arg,undefined];
    const value=inline??extra[++index];
    if(flag==='--local-rpc'&&localRpc===undefined&&value!==undefined){
      if(command!=='test')throw new Error('--local-rpc is available only with the test command');
      if(value!==LOCAL_RPC_ENDPOINT)throw new Error(`Local RPC testing accepts only ${LOCAL_RPC_ENDPOINT}`);
      localRpc=value;
    }else if(flag==='--target'&&target===undefined&&value!==undefined){
      if(!['new','build','test'].includes(command))throw new Error('--target is available only with new, build and test');
      if(!Object.hasOwn(PROJECT_TARGETS,value))throw new Error(`Unknown target ${value}; choose ${Object.keys(PROJECT_TARGETS).join(' or ')}`);
      target=value as ProjectTarget;
    }else throw new Error(usage);
  }
  return {command,directory,options:{...(localRpc?{localRpc}:{}),...(target?{target}:{})}};
}
