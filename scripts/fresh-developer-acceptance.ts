import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {libraryTarget,libraryTools} from '../compiler/target-profile.ts';

const repository=path.resolve(import.meta.dir,'..');
const evidence=path.resolve(process.env.FRESH_DEVELOPER_EVIDENCE??path.join(repository,'build/fresh-developer-acceptance'));
const reportPath=path.join(evidence,'acceptance.json');
// A previous success must not survive even if source staging or a prerequisite fails.
fs.rmSync(reportPath,{force:true});
fs.mkdirSync(evidence,{recursive:true});
let logDirectory=evidence;

const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel=(file:string)=>path.relative(repository,file).split(path.sep).join('/');
const cleanupNames=new Set(['.git','.deps','.fadeno','node_modules','target','build','dist','.venv','vendor']);
const secretFile=/(^\.env(?:\..*)?$|(?:^|[._-])(?:keypair|private-key|payer|wallet|secret)(?:[._-]|$)|(?:keypair|key)\.(?:json|ya?ml)$|^id(?:_(?:rsa|ed25519))?(?:\.json|$)|\.(?:pem|p12|pfx|key)$)/i;
const binarySuffix=/\.(?:so|dylib|dll|o|a|rlib|wasm|class)$/i;

type RunOptions={cwd?:string;env?:NodeJS.ProcessEnv;semantic?:RegExp;expected:'pass'|'semantic-failure'};
type CommandResult={status:number|null;output:string;logPath:string};

function commandText(command:string,args:string[]){return `$ ${command} ${args.join(' ')}\n`;}
function writeLog(label:string,output:string){
  const logPath=path.join(logDirectory,`${label}.log`);
  fs.writeFileSync(logPath,output);
  return logPath;
}
function runCommand(label:string,command:string,args:string[],options:RunOptions):CommandResult{
  const result=spawnSync(command,args,{cwd:options.cwd??repository,encoding:'utf8',env:{...process.env,BEND_NO_TELEMETRY:'1',...options.env}});
  const output=commandText(command,args)+`${result.stdout??''}${result.stderr??''}`;
  const logPath=writeLog(label,output);
  const clean=result.error===undefined&&result.signal===null&&result.status!==null;
  if(options.expected==='pass'){
    if(!clean||result.status!==0)throw new Error(`${label}: expected a clean exit 0; status ${result.status}${result.signal?`, signal ${result.signal}`:''}${result.error?`, spawn error ${result.error.message}`:''}; see ${logPath}`);
  }else{
    if(!clean||result.status===0||!options.semantic?.test(output))throw new Error(`${label}: expected semantic rejection${options.semantic?` matching ${options.semantic}`:''}; status ${result.status}${result.signal?`, signal ${result.signal}`:''}${result.error?`, spawn error ${result.error.message}`:''}; see ${logPath}`);
  }
  return {status:result.status,output,logPath};
}
function runCargo(label:string,args:string[],cwd:string,env:NodeJS.ProcessEnv){
  return runCommand(label,'cargo',args,{cwd,env,expected:'pass'});
}
function recordCommand(commands:Record<string,string>,label:string,result:CommandResult){
  commands[label]=rel(result.logPath);
}
function sourceExcluded(relative:string){
  const parts=relative.split('/');
  return parts.some(part=>cleanupNames.has(part))||secretFile.test(parts.at(-1)??'')||binarySuffix.test(relative);
}
function sourceInventory(sourceRoot:string,stagedSource:string){
  const listing=spawnSync('git',['-C',sourceRoot,'ls-files','-z'],{encoding:'buffer'});
  if(listing.error||listing.status!==0)throw new Error(`Could not inventory tracked source files: ${listing.error?.message??listing.stderr?.toString('utf8')??listing.status}`);
  const ownedNew=['scripts/fresh-developer-acceptance.ts','scripts/fresh-developer-tutorial.ts'];
  const tracked=listing.stdout.toString('utf8').split('\0').filter(Boolean);
  const sourceFiles=[...new Set([...tracked,...ownedNew])].sort();
  const copied:Array<{path:string;sha256:string}>=[];
  const excluded:Array<{path:string;reason:string}>=[];
  for(const relative of sourceFiles){
    if(sourceExcluded(relative)){
      excluded.push({path:relative,reason:'generated-output-or-key-material exclusion'});
      continue;
    }
    const from=path.join(sourceRoot,relative);
    if(!fs.existsSync(from)||!fs.statSync(from).isFile())continue;
    const to=path.join(stagedSource,relative);
    fs.mkdirSync(path.dirname(to),{recursive:true});
    fs.copyFileSync(from,to);
    copied.push({path:relative,sha256:hash(to)});
  }
  return {copied,excluded,trackedFiles:tracked.length};
}
function linkCache(stageRoot:string,cacheName:string,cachePath:string){
  if(!fs.existsSync(cachePath))throw new Error(`Required pinned cache is missing: ${cachePath}`);
  const linkPath=path.join(stageRoot,cacheName);
  fs.mkdirSync(path.dirname(linkPath),{recursive:true});
  fs.symlinkSync(path.resolve(cachePath),linkPath,'dir');
  return fs.realpathSync(cachePath);
}
function hostVersion(command:string,args:string[]){
  const result=spawnSync(command,args,{encoding:'utf8'});
  return {ok:!result.error&&result.signal===null&&result.status===0,version:`${result.stdout??''}${result.stderr??''}`.trim().split('\n')[0]??result.error?.message??'unavailable'};
}
function assertFile(file:string){
  if(!fs.existsSync(file)||!fs.statSync(file).isFile())throw new Error(`Expected gate output is missing: ${file}`);
}

export type FreshDeveloperAcceptanceResult={
  reportPath:string;
  stagedRepository:string;
  projectDirectory:string;
  programPath:string;
  elfPath:string;
  report:Record<string,unknown>;
};

export async function runFreshDeveloperAcceptance():Promise<FreshDeveloperAcceptanceResult>{
  // Exported callers may invoke the runner more than once in one process.
  fs.rmSync(reportPath,{force:true});
  const stamp=Date.now();
  logDirectory=path.join(evidence,`logs-${stamp}`);
  fs.mkdirSync(logDirectory,{recursive:true});
  const stageRoot=path.join(evidence,`staging-${stamp}`);
  const stagedSource=path.join(stageRoot,'source');
  const projectDirectory=path.join(stagedSource,'projects','fresh-developer-acceptance');
  const logs:Record<string,string>={};
  fs.mkdirSync(stagedSource,{recursive:true});

  const gitHead=hostVersion('git',['-C',repository,'rev-parse','HEAD']);
  const gitStatus=spawnSync('git',['-C',repository,'status','--porcelain'],{encoding:'utf8'});
  const inventory=sourceInventory(repository,stagedSource);
  const nodeModules=linkCache(stagedSource,'node_modules',path.join(repository,'node_modules'));
  const bendCache=linkCache(stagedSource,'.deps/bend',path.join(repository,'.deps/bend'));
  const cargoCache=path.join(evidence,'runner-target');
  const reuseCargoCache=fs.existsSync(path.join(cargoCache,'debug/bend-test-runner'));
  fs.mkdirSync(cargoCache,{recursive:true});
  const cargoTarget=cargoCache;
  fs.symlinkSync(cargoCache,path.join(stagedSource,'target'),'dir');
  const stageEnv:NodeJS.ProcessEnv={CARGO_TARGET_DIR:cargoTarget};
  const bun=process.execPath;
  const doctorFile=path.join(evidence,`doctor-${stamp}.json`);
  const doctor=runCommand('doctor',''+bun,[path.join(stagedSource,'scripts/alpha-doctor.ts'),'--json','--write',doctorFile],
    {cwd:stagedSource,env:stageEnv,expected:'pass'});
  recordCommand(logs,'doctor',doctor);
  const jsonStart=doctor.output.indexOf('{');
  if(jsonStart<0)throw new Error(`Doctor output did not include its JSON report; see ${doctor.logPath}`);
  const doctorReport=JSON.parse(doctor.output.slice(jsonStart));
  const cargoBuild=runCargo('test-runner-build',['build','--locked','--offline','--manifest-path','scripts/test-runner/Cargo.toml'],stagedSource,stageEnv);
  recordCommand(logs,'test-runner-build',cargoBuild);

  const cli=path.join(stagedSource,'scripts/bend.ts');
  const create=runCommand('new',bun,[cli,'new',path.relative(stagedSource,projectDirectory)],{cwd:stagedSource,env:stageEnv,expected:'pass'});
  recordCommand(logs,'new',create);
  const helper=path.join(stagedSource,'scripts/fresh-developer-tutorial.ts');
  const edit=runCommand('apply-tutorial',bun,[helper,projectDirectory],{cwd:stagedSource,env:stageEnv,expected:'pass'});
  recordCommand(logs,'apply-tutorial',edit);

  const projectCommand=(label:string,name:string)=>{
    const result=runCommand(label,bun,[cli,name,projectDirectory],{cwd:stagedSource,env:stageEnv,expected:'pass'});
    recordCommand(logs,label,result);
    return result;
  };
  projectCommand('check-initial','check');
  projectCommand('verify-initial','verify');
  projectCommand('build-initial','build');
  projectCommand('test-initial','test');

  const programPath=path.join(projectDirectory,'program.bend');
  const originalProgram=fs.readFileSync(programPath,'utf8');
  const mutationNeedle=`    case True{}:\n      Rejected{4}`;
  const mutationReplacement=`    case True{}:\n      Rejected{5}`;
  const mutationCount=originalProgram.split(mutationNeedle).length-1;
  if(mutationCount!==1)throw new Error(`zero-append mutation: expected one exact code-4 branch, found ${mutationCount}`);
  const mutatedProgram=originalProgram.replace(mutationNeedle,mutationReplacement);
  const mutationProgramSha256=crypto.createHash('sha256').update(mutatedProgram).digest('hex');
  let verifyMutation:CommandResult|undefined;
  let buildMutation:CommandResult|undefined;
  fs.writeFileSync(programPath,mutatedProgram);
  try{
    const semantic=/expected\s*:\s*program\.Rejected\{5\}[\s\S]*observed\s*:\s*program\.Rejected\{4\}[\s\S]*Location:\s*LAWS\.zero_append_is_rejected/i;
    verifyMutation=runCommand('zero-law-mutation-verify',bun,[cli,'verify',projectDirectory],
      {cwd:stagedSource,env:stageEnv,expected:'semantic-failure',semantic});
    recordCommand(logs,'zero-law-mutation-verify',verifyMutation);
    buildMutation=runCommand('zero-law-mutation-build',bun,[cli,'build',projectDirectory],
      {cwd:stagedSource,env:stageEnv,expected:'semantic-failure',semantic});
    recordCommand(logs,'zero-law-mutation-build',buildMutation);
  }finally{
    fs.writeFileSync(programPath,originalProgram);
  }

  projectCommand('check-restored','check');
  projectCommand('verify-restored','verify');
  projectCommand('build-restored','build');
  projectCommand('test-restored','test');

  // Seed a stale success in a separate evidence directory and prove this exact
  // entry point removes it before reporting a semantic prerequisite failure.
  const staleProbe=path.join(evidence,'stale-report-probe');
  fs.mkdirSync(staleProbe,{recursive:true});
  const staleReport=path.join(staleProbe,'acceptance.json');
  fs.writeFileSync(staleReport,JSON.stringify({passed:true,stale:true})+'\n');
  const prerequisite=runCommand('stale-report-removal-probe',bun,[path.join(stagedSource,'scripts/fresh-developer-acceptance.ts'),'--intentional-prerequisite-failure'],
    {cwd:stagedSource,env:{...stageEnv,FRESH_DEVELOPER_EVIDENCE:staleProbe},expected:'semantic-failure',semantic:/No bend\.json/});
  recordCommand(logs,'stale-report-removal-probe',prerequisite);
  if(fs.existsSync(staleReport))throw new Error('stale-report removal probe left its old success report in place');

  const {BEND_COMMIT}=await import('./build.ts');
  const projectFiles=['program.bend','LAWS.bend','PROOF.bend','test.ts','storage.json','bend.json']
    .map(name=>path.join(projectDirectory,name));
  const clientStem=path.join(projectDirectory,'dist/program');
  const fogoStem=path.join(projectDirectory,'dist/fogo/program');
  const solanaStem=path.join(projectDirectory,'dist/solana/program');
  const outputFiles=[solanaStem+'.so',solanaStem+'.manifest.json',solanaStem+'.test-report.json',
    fogoStem+'.so',fogoStem+'.manifest.json',clientStem+'.client.ts',clientStem+'.client.js',
    clientStem+'.client-runtime.js',clientStem+'.client-runtime.d.ts',fogoStem+'.test-report.json',
  ];
  for(const file of outputFiles)assertFile(file);
  const gateInputs=['scripts/fresh-developer-acceptance.ts','scripts/fresh-developer-tutorial.ts',
    'docs/external-alpha-tutorial.md','scripts/bend.ts','scripts/build.ts','scripts/program.ts','sdk/testing.ts']
    .map(relative=>path.join(stagedSource,relative));
  for(const file of gateInputs)assertFile(file);
  const runnerInputs=['scripts/test-runner/Cargo.toml','scripts/test-runner/Cargo.lock','scripts/test-runner/src/main.rs']
    .map(relative=>path.join(stagedSource,relative));
  for(const file of runnerInputs)assertFile(file);
  const runnerBinary=path.join(cargoTarget,'debug/bend-test-runner');
  assertFile(runnerBinary);
  const bentHead=hostVersion('git',['-C',bendCache,'rev-parse','HEAD']);
  const bentStatus=spawnSync('git',['-C',bendCache,'status','--porcelain'],{encoding:'utf8'});
  // Both project targets build with platform-tools v1.57.
  const platformTools=libraryTools(libraryTarget('fogo-v0'));
  const sbfClang=hostVersion(path.join(platformTools,'clang'),['--version']);
  const report:Record<string,unknown>={
    version:1,
    passed:true,
    gate:'fresh developer offline acceptance',
    generatedAt:new Date().toISOString(),
    sourceCopy:{
      method:'copied current working-tree contents for git-tracked paths plus this gate and helper; no recursive copy of untracked files',
      sourceCommit:gitHead.version,
      sourceWorkingTreeClean:gitStatus.status===0&&(gitStatus.stdout??'').trim()==='',
      sourceCopyIsCleanBuildTree:true,
      copiedTrackedFileCount:inventory.trackedFiles,
      copiedFileCount:inventory.copied.length,
      copiedFiles:inventory.copied,
      exclusions:inventory.excluded,
      stagedRepository:rel(stagedSource),
      projectDirectory:rel(projectDirectory),
      retainedForLocalAcceptance:true,
    },
    tutorial:{
      businessRule:'Append(value=0) returns application error code 4; nonzero Append and Replace retain the starter behavior.',
      lawScope:'Program.apply after authorization and collection selection; earlier account-level checks may reject with their own codes.',
      edits:[
        {file:'program.bend',description:'guard the Append branch with U32.is_zero and reject zero with code 4'},
        {file:'LAWS.bend',description:'declare zero_append_is_rejected for every state, length and selected window'},
        {file:'PROOF.bend',description:'prove zero_append_is_rejected'},
        {file:'test.ts',description:'assert zero append rollback, nonzero append behavior, and that Replace still accepts zero'},
      ],
      changedProjectFiles:projectFiles.map(file=>({path:rel(file),sha256:hash(file)})),
    },
    prerequisites:{doctor:doctorReport},
    provenance:{
      host:{platform:os.platform(),architecture:os.arch(),node:hostVersion('node',['--version']),bun:hostVersion(bun,['--version']),cargo:hostVersion('cargo',['--version']),rustc:hostVersion('rustc',['--version']),hostClang:hostVersion('clang',['--version'])},
      pinned:{bun:'1.4.2',typescript:'5.2.2',rust:'1.92.0',anzaPlatformTools:'v1.57 / clang 22.1.2',bendCommit:BEND_COMMIT},
      caches:{
        npm:{path:nodeModules,source:path.join(repository,'node_modules'),reused:true},
        bend:{path:bendCache,source:path.join(repository,'.deps/bend'),commit:bentHead.version,clean:bentStatus.status===0&&(bentStatus.stdout??'').trim()==='',reused:true},
        cargo:{home:process.env.CARGO_HOME??path.join(os.homedir(),'.cargo'),registryAndGitCachesReused:true,
          targetOutput:rel(cargoTarget),targetCacheReused:reuseCargoCache,runnerBinary:{path:rel(runnerBinary),sha256:hash(runnerBinary)},
          runnerInputs:Object.fromEntries(runnerInputs.map(file=>[rel(file),hash(file)]))},
        sbf:{path:platformTools,clang:sbfClang.version,reused:true},
      },
      independence:'The gate copied current tracked source into a clean build tree and reused the listed local tool/dependency caches. This is not a fresh machine, fresh OS account, or independent developer run.',
    },
    commands:logs,
    lawMutation:{
      law:'zero_append_is_rejected',
      sourceChange:{from:'Rejected{4}',to:'Rejected{5}',matches:mutationCount},
      mutatedProgramSha256:mutationProgramSha256,
      verifyRejected:verifyMutation?.status!==0,
      buildRejected:buildMutation?.status!==0,
      bothSemanticFailures:true,
      sourceRestored:true,
    },
    staleReportProbe:{
      staleSuccessSeeded:true,
      prerequisiteFailureWasSemantic:true,
      staleSuccessRemoved:!fs.existsSync(staleReport),
    },
    outputs:{
      target:'fogo',
      elf:{path:rel(fogoStem+'.so'),sha256:hash(fogoStem+'.so'),bytes:fs.statSync(fogoStem+'.so').size},
      manifest:{path:rel(fogoStem+'.manifest.json'),sha256:hash(fogoStem+'.manifest.json')},
      generatedClient:['.client.ts','.client.js','.client-runtime.js','.client-runtime.d.ts'].map(suffix=>({path:rel(clientStem+suffix),sha256:hash(clientStem+suffix)})),
      testReport:{path:rel(fogoStem+'.test-report.json'),sha256:hash(fogoStem+'.test-report.json')},
      solana:{
        elf:{path:rel(solanaStem+'.so'),sha256:hash(solanaStem+'.so'),bytes:fs.statSync(solanaStem+'.so').size},
        manifest:{path:rel(solanaStem+'.manifest.json'),sha256:hash(solanaStem+'.manifest.json')},
        testReport:{path:rel(solanaStem+'.test-report.json'),sha256:hash(solanaStem+'.test-report.json')},
      },
      finishedProject:rel(projectDirectory),
      finishedStagedRepository:rel(stagedSource),
    },
    gateInputs:Object.fromEntries(gateInputs.map(file=>[rel(file),hash(file)])),
    limitations:[
      'The source laws prove only their declared Bend-level properties; the gate does not prove compiler correctness, ELF behavior in general, or production safety.',
      'The retained staged source and built ELF are ready for a later local deployment acceptance step; this gate performs no RPC or deployment.',
    ],
  };
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(`Fresh-developer offline acceptance passed: ${reportPath}`);
  return {reportPath,stagedRepository:stagedSource,projectDirectory,programPath,elfPath:fogoStem+'.so',report};
}

if(import.meta.main){
  try{
    if(process.argv.includes('--intentional-prerequisite-failure')){
      const missingProject=path.join(evidence,`missing-prerequisite-${Date.now()}`);
      const bun=process.execPath;
      const result=spawnSync(bun,[path.join(repository,'scripts/bend.ts'),'check',missingProject],
        {cwd:repository,encoding:'utf8',env:{...process.env,BEND_NO_TELEMETRY:'1'}});
      const output=commandText(bun,[path.join(repository,'scripts/bend.ts'),'check',missingProject])+`${result.stdout??''}${result.stderr??''}`;
      const logPath=writeLog('intentional-prerequisite-failure',output);
      if(result.status===0||result.signal!==null||result.error||!/No bend\.json/.test(output)){
        console.error(`Intentional prerequisite failure was not semantic; see ${logPath}`);
        process.exitCode=2;
      }else{
        console.error(output);
        process.exitCode=1;
      }
    }else await runFreshDeveloperAcceptance();
  }catch(error){
    console.error(error instanceof Error?error.stack??error.message:String(error));
    process.exitCode=1;
  }
}
