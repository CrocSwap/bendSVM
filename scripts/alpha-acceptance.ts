import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {BEND_COMMIT} from './build.ts';

const repository=path.resolve(import.meta.dir,'..');
const bun=process.execPath;
const stamp=Date.now();
const evidence=path.join(repository,'build','external-alpha');
const reportPath=path.join(evidence,'acceptance.json');
// A previous pass is never evidence for this invocation. Remove it before
// creating staging state or starting any prerequisite-sensitive work.
fs.rmSync(reportPath,{force:true});
fs.mkdirSync(evidence,{recursive:true});

if(process.argv.includes('--intentional-prerequisite-failure')){
  const missingProject=path.join(evidence,`missing-prerequisite-${stamp}`);
  const result=spawnSync(bun,['scripts/bend.ts','check',missingProject],{
    cwd:repository,encoding:'utf8',env:{...process.env,BEND_NO_TELEMETRY:'1'}});
  const output=`$ ${bun} scripts/bend.ts check ${missingProject}\n${result.stdout??''}${result.stderr??''}`;
  if(result.status===0||result.signal||result.error||!/No bend\.json/.test(output)){
    console.error(`Prerequisite-failure probe did not fail semantically as expected:\n${output}`);
    process.exit(2);
  }
  console.error(`Intentional prerequisite failure: ${output}`);
  process.exit(1);
}

const staging=fs.mkdtempSync(path.join(evidence,`staging-${stamp}-`));
const project=path.join(staging,'Starter Project');
const logs:Record<string,string>={};
type Expectation={exit:0|'nonzero';semantic?:RegExp};
const run=(label:string,args:string[],expectation:Expectation)=>{
  const result=spawnSync(bun,args,{cwd:repository,encoding:'utf8',env:{...process.env,BEND_NO_TELEMETRY:'1'}});
  const output=`$ ${bun} ${args.join(' ')}\n${result.stdout??''}${result.stderr??''}`;
  const log=path.join(evidence,`${label}.log`);fs.writeFileSync(log,output);logs[label]=path.relative(repository,log);
  const cleanExit=result.signal===null&&!result.error;
  if(expectation.exit===0){
    if(result.status!==0||!cleanExit)throw new Error(`${label}: expected exit 0, got ${result.status}${result.signal?` (${result.signal})`:''}; see ${log}`);
  }else if(result.status===0||!cleanExit||(expectation.semantic&&!expectation.semantic.test(output))){
    throw new Error(`${label}: expected a semantic rejection (non-zero exit without signal/spawn error)${expectation.semantic?' matching '+expectation.semantic:''}; see ${log}`);
  }
  return {status:result.status,output};
};
const cargo=(label:string,args:string[])=>{
  const result=spawnSync('cargo',args,{cwd:repository,encoding:'utf8'});
  const output=`$ cargo ${args.join(' ')}\n${result.stdout??''}${result.stderr??''}`;
  const log=path.join(evidence,`${label}.log`);fs.writeFileSync(log,output);logs[label]=path.relative(repository,log);
  if(result.status!==0)throw new Error(`${label} failed; see ${log}`);
};

const doctor=run('doctor',['scripts/alpha-doctor.ts','--json','--write',path.join(evidence,'doctor.json')],{exit:0});
const doctorReport=JSON.parse(doctor.output.slice(doctor.output.indexOf('{')));
cargo('test-runner-build',['build','--locked','--manifest-path','scripts/test-runner/Cargo.toml']);
run('new',['scripts/bend.ts','new',project],{exit:0});
run('check',['scripts/bend.ts','check',project],{exit:0});
run('verify',['scripts/bend.ts','verify',project],{exit:0});
run('build',['scripts/bend.ts','build',project],{exit:0});
run('test',['scripts/bend.ts','test',project],{exit:0});

// A declared law is part of the checked source contract. Deliberately violate
// one in a fresh staged project and require verification/build to reject it.
const program=path.join(project,'program.bend');
const original=fs.readFileSync(program,'utf8');
const replaceMatched=(source:string,needle:string,replacement:string,label:string)=>{
  const count=source.split(needle).length-1;
  if(count===0)throw new Error(`${label}: expected at least one '${needle}' match, found none`);
  const changed=source.replaceAll(needle,replacement);
  if(changed===source)throw new Error(`${label}: mutation did not change the source`);
  return {changed,count};
};
const mutation=replaceMatched(original,'Rejected{1}','Rejected{4}','law mutation');
fs.writeFileSync(program,mutation.changed);
const semanticLawRejection=/expected\s*:\s*program\.Rejected\{4\}[\s\S]*observed\s*:\s*program\.Rejected\{1\}/;
let lawFailure:{status:number|null;output:string};
let buildFailure:{status:number|null;output:string};
try{
  lawFailure=run('law-failure-verify',['scripts/bend.ts','verify',project],{exit:'nonzero',semantic:semanticLawRejection});
  buildFailure=run('law-failure-build',['scripts/bend.ts','build',project],{exit:'nonzero',semantic:semanticLawRejection});
}finally{fs.writeFileSync(program,original);}
const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const evidenceFiles=[
  path.join(project,'bend.json'),
  path.join(project,'program.bend'),
  path.join(project,'LAWS.bend'),
  path.join(project,'PROOF.bend'),
  path.join(project,'test.ts'),
  path.join(project,'dist/program.so'),
  path.join(project,'dist/program.manifest.json'),
  path.join(project,'dist/program.client.js'),
  path.join(project,'dist/program.test-report.json'),
  path.join(repository,'scripts/bend.ts'),
  path.join(repository,'scripts/alpha-acceptance.ts'),
  path.join(repository,'package-lock.json'),
  path.join(repository,'target/debug/bend-test-runner'),
];

const report={
  version:1,
  passed:true,
  generatedAt:new Date().toISOString(),
  stagingDirectory:path.relative(repository,staging),
  projectDirectory:path.relative(repository,project),
  sourceInputs:{
    bendCommit:BEND_COMMIT,
    stagedProjectFiles:['bend.json','program.bend','LAWS.bend','PROOF.bend','storage.json','test.ts']
      .map(name=>({path:path.relative(repository,path.join(project,name)),sha256:hash(path.join(project,name))})),
    acceptanceScript:{path:'scripts/alpha-acceptance.ts',sha256:hash(path.join(repository,'scripts/alpha-acceptance.ts'))},
    packageLock:{path:'package-lock.json',sha256:hash(path.join(repository,'package-lock.json'))},
  },
  doctor:doctorReport,
  commands:{...logs},
  lawFailure:{needle:'Rejected{1}',replacement:'Rejected{4}',matches:mutation.count,
    verifyRejected:lawFailure.status!==0,buildRejected:buildFailure.status!==0},
  outputs:{
    elf:path.relative(repository,path.join(project,'dist/program.so')),
    manifest:path.relative(repository,path.join(project,'dist/program.manifest.json')),
    client:path.relative(repository,path.join(project,'dist/program.client.js')),
    testReport:path.relative(repository,path.join(project,'dist/program.test-report.json')),
  },
  hashes:Object.fromEntries(evidenceFiles.map(file=>[path.relative(repository,file),hash(file)])),
  reusedTooling:{
    source:'starter created by scripts/bend.ts in the isolated staging directory; no repository build artifact was copied',
    bun:'node_modules/bun@1.4.2 via the current Bun process',
    typescript:'node_modules/typescript@5.2.2 (packaged lockfile dependency; no host cache)',
    bend:`.deps/bend at pinned commit ${BEND_COMMIT}`,
    sbf:'SBF_TOOLS or ~/.cache/solana/v1.53/platform-tools/llvm/bin; reported by doctor',
    rust:'Cargo registry/git caches and target/debug/bend-test-runner, explicitly rebuilt by this gate',
    python:'not required by the ordinary alpha gate; PYTHON with z3-solver==5.1.0 is an explicit refinement-only dependency',
  },
  claims:[
    'Starter source laws, checked compilation and a real SBF LiteSVM test passed.',
    'The deliberate source-law mutation was rejected by verify and build.',
    'This gate does not prove compiler lowering, deployed binary correctness, or production safety.',
  ],
};
fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
// Re-run the acceptance entry point after a successful pass with an absent
// project prerequisite. Its startup cleanup must remove the prior success
// marker, and the failure must be a real CLI prerequisite error rather than a
// signal, spawn error or unrelated failure.
run('prerequisite-failure',['scripts/alpha-acceptance.ts','--intentional-prerequisite-failure'],
  {exit:'nonzero',semantic:/No bend\.json/});
if(fs.existsSync(reportPath))throw new Error('prerequisite failure left stale acceptance.json success marker');
report.commands={...logs};
fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(`External-alpha acceptance passed: ${reportPath}`);
