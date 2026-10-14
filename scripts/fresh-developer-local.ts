import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

// Extend a completed offline gate without silently replacing its source or ELF.
const repository=path.resolve(import.meta.dir,'..');
const evidence=path.resolve(process.env.FRESH_DEVELOPER_EVIDENCE??path.join(repository,'build/fresh-developer-acceptance'));
const reportPath=path.join(evidence,'local-acceptance.json');
fs.rmSync(reportPath,{force:true});
fs.mkdirSync(evidence,{recursive:true});
const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const endpoint='http://127.0.0.1:18899';
type FileHash={path:string;sha256:string};
type OfflineReport={
  version:number;gate:string;
  passed:boolean;
  lawMutation:{law:string;verifyRejected:boolean;buildRejected:boolean;bothSemanticFailures:boolean;sourceRestored:boolean};
  staleReportProbe:{staleSuccessSeeded:boolean;prerequisiteFailureWasSemantic:boolean;staleSuccessRemoved:boolean};
  sourceCopy:{stagedRepository:string;projectDirectory:string;copiedFiles:FileHash[]};
  tutorial:{changedProjectFiles:FileHash[]};
  gateInputs:Record<string,string>;
  outputs:{target?:string;elf:FileHash;manifest:FileHash;generatedClient:FileHash[];testReport:FileHash};
};

try {
  if(process.argv.length!==2)throw new Error('Usage: npm run acceptance:developer:local (requires the local validator on port 18899)');
  const offlinePath=path.join(evidence,'acceptance.json');
  if(!fs.existsSync(offlinePath))throw new Error('Missing offline acceptance report; run npm run acceptance:developer first.');
  const offline=JSON.parse(fs.readFileSync(offlinePath,'utf8')) as OfflineReport;
  assert.equal(offline.passed,true,'Offline acceptance must have passed');
  assert.equal(offline.version,1,'Unsupported offline acceptance report');
  assert.equal(offline.gate,'fresh developer offline acceptance','Expected the fresh developer offline gate');
  assert.equal(offline.lawMutation?.law,'zero_append_is_rejected','Missing new-law mutation evidence');
  for(const field of ['verifyRejected','buildRejected','bothSemanticFailures','sourceRestored'] as const)
    assert.equal(offline.lawMutation[field],true,`Offline law mutation gate incomplete: ${field}`);
  for(const field of ['staleSuccessSeeded','prerequisiteFailureWasSemantic','staleSuccessRemoved'] as const)
    assert.equal(offline.staleReportProbe?.[field],true,`Offline stale-report gate incomplete: ${field}`);
  assert(offline.sourceCopy?.copiedFiles?.length>0&&offline.tutorial?.changedProjectFiles?.length>0,
    'Offline acceptance must record staged source and project hashes');
  const offlineHash=hash(offlinePath);
  const stage=path.resolve(repository,offline.sourceCopy.stagedRepository);
  const project=path.resolve(repository,offline.sourceCopy.projectDirectory);
  const inputs=[
    ...offline.sourceCopy.copiedFiles.map(file=>({path:path.join(stage,file.path),sha256:file.sha256})),
    ...offline.tutorial.changedProjectFiles,
    ...Object.entries(offline.gateInputs).map(([file,sha256])=>({path:file,sha256})),
    offline.outputs.elf,offline.outputs.manifest,offline.outputs.testReport,...offline.outputs.generatedClient,
  ];
  const verifyInputs=()=>{
    assert.equal(hash(offlinePath),offlineHash,'Offline acceptance report changed during local validation');
    for(const file of inputs)assert.equal(hash(path.resolve(repository,file.path)),file.sha256,
      `Offline acceptance input changed: ${file.path}; rerun npm run acceptance:developer`);
  };
  verifyInputs();
  const config=JSON.parse(fs.readFileSync(path.join(project,'bend.json'),'utf8'));
  // A targeted project tests the offline-tested target only; its outputs live in <output-dir>/<target>/.
  const target=config.targets?offline.outputs.target:undefined;
  if(config.targets&&!target)throw new Error('Offline acceptance did not record which target it tested');
  const stem=path.resolve(project,config.output);
  const localReportPath=(target?path.join(path.dirname(stem),target,path.basename(stem)):stem)+'.local-test-report.json';
  fs.rmSync(localReportPath,{force:true});
  const command=[path.join(stage,'scripts/bend.ts'),'test',project,...(target?['--target',target]:[]),'--local-rpc',endpoint];
  const result=spawnSync(process.execPath,command,{cwd:stage,encoding:'utf8',
    env:{...process.env,BEND_NO_TELEMETRY:'1'},maxBuffer:16*1024*1024});
  const log=path.join(evidence,'local-test.log');
  fs.writeFileSync(log,JSON.stringify({executable:process.execPath,args:command})+'\n'+(result.stdout??'')+(result.stderr??''));
  if(result.error||result.signal||result.status!==0)throw new Error(`Local developer test failed (${result.error?.message??result.signal??result.status}); see ${log}`);
  verifyInputs();
  const local=JSON.parse(fs.readFileSync(localReportPath,'utf8'));
  assert.equal(local.passed,true);
  assert.equal(local.backend,'local-rpc');
  assert.equal(local.endpoint,endpoint);
  assert.equal(local.elfSha256,offline.outputs.elf.sha256,'Local deployment must use the offline-tested ELF');
  assert.equal(local.sourceManifestSha256,offline.outputs.manifest.sha256,'Local deployment must use the offline-tested manifest');
  const elf=fs.readFileSync(path.resolve(repository,offline.outputs.elf.path));
  const deployedPath=path.resolve(stage,local.runDirectory,'deployed.so');
  const deployed=fs.readFileSync(deployedPath);
  assert(elf.length>0&&deployed.length>=elf.length&&deployed.subarray(0,elf.length).equals(elf)&&
    deployed.subarray(elf.length).every(byte=>byte===0),'Deployed bytes differ from the offline-tested ELF');
  assert.deepEqual(local.byteMatch,{matchedBytes:elf.length,deployedBytes:deployed.length,zeroPaddingBytes:deployed.length-elf.length},
    'Local byte-match evidence is missing or inconsistent');
  assert(local.programCalls>0&&local.assertions>0&&local.rejected>0,'Local acceptance must exercise the program and expected rejection');
  assert(local.signatures.length>0,'Local acceptance must record confirmed transactions');
  const receiptPath=path.resolve(stage,local.receiptPath);
  const report={version:1,passed:true,generatedAt:new Date().toISOString(),endpoint,
    offlineAcceptance:{path:offlinePath,sha256:offlineHash},
    localTest:{path:localReportPath,sha256:hash(localReportPath)},
    receipts:{path:receiptPath,sha256:hash(receiptPath)},
    deployedElf:{path:deployedPath,sha256:hash(deployedPath)},
    coordinator:{path:'scripts/fresh-developer-local.ts',sha256:hash(import.meta.path)},
    elfSha256:local.elfSha256,sourceManifestSha256:local.sourceManifestSha256,
    program:local.program,byteMatch:local.byteMatch,
    summary:{successful:local.successful,rejected:local.rejected,assertions:local.assertions},
    limitations:['Local validator execution with reused host tooling; not an independent developer trial or Linux CI result.',
      'Source laws and byte equality do not prove compiler or deployed-program correctness.']};
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(`Fresh-developer local acceptance passed: ${reportPath}`);
}catch(error){
  console.error(error instanceof Error?error.message:String(error));
  process.exitCode=1;
}
