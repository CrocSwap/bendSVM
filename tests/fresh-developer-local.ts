import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

// No case contacts a validator; the last two use a controlled CLI stub.
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bend-developer-local-'));
const report=path.join(dir,'local-acceptance.json');
const script=path.resolve(import.meta.dir,'../scripts/fresh-developer-local.ts');
const reject=(pattern:RegExp)=>{
  fs.writeFileSync(report,'{"passed":true,"stale":true}\n');
  const result=spawnSync(process.execPath,[script],{encoding:'utf8',
    env:{...process.env,FRESH_DEVELOPER_EVIDENCE:dir}});
  assert.equal(result.error,undefined);
  assert.equal(result.signal,null);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.match(result.stderr,pattern);
  assert(!fs.existsSync(report),'A failed local gate must remove its old success report');
};
try {
  reject(/Missing offline acceptance report/);
  const source=path.join(dir,'program.bend');
  const expected=crypto.createHash('sha256').update('original source').digest('hex');
  fs.writeFileSync(source,'changed source');
  const file={path:source,sha256:expected};
  const offlinePath=path.join(dir,'acceptance.json');
  const offline={passed:true,version:1,gate:'fresh developer offline acceptance',
    lawMutation:{law:'zero_append_is_rejected',verifyRejected:true,buildRejected:true,bothSemanticFailures:true,sourceRestored:true},
    staleReportProbe:{staleSuccessSeeded:true,prerequisiteFailureWasSemantic:true,staleSuccessRemoved:true},
    sourceCopy:{stagedRepository:dir,projectDirectory:dir,copiedFiles:[{...file,path:'program.bend'}]},
    tutorial:{changedProjectFiles:[file]},gateInputs:{},
    outputs:{elf:file,manifest:file,testReport:file,generatedClient:[file]}};
  fs.writeFileSync(offlinePath,JSON.stringify({...offline,lawMutation:{...offline.lawMutation,buildRejected:false}}));
  reject(/Offline law mutation gate incomplete/);
  fs.writeFileSync(offlinePath,JSON.stringify(offline));
  reject(/Offline acceptance input changed/);
  fs.writeFileSync(source,'original source');
  fs.writeFileSync(path.join(dir,'bend.json'),JSON.stringify({output:'program'}));
  fs.mkdirSync(path.join(dir,'scripts'));
  fs.mkdirSync(path.join(dir,'run'));
  const local={passed:true,backend:'local-rpc',endpoint:'http://127.0.0.1:18899',elfSha256:expected,
    sourceManifestSha256:expected,runDirectory:'run',byteMatch:false};
  const stub=(value:unknown)=>fs.writeFileSync(path.join(dir,'scripts/bend.ts'),
    `import fs from 'node:fs'; fs.writeFileSync('program.local-test-report.json',${JSON.stringify(JSON.stringify(value))});`);
  fs.writeFileSync(path.join(dir,'run/deployed.so'),'original source');
  stub(local);
  reject(/Local byte-match evidence is missing or inconsistent/);
  fs.writeFileSync(path.join(dir,'run/deployed.so'),'different bytes');
  stub({...local,byteMatch:{matchedBytes:15,deployedBytes:15,zeroPaddingBytes:0}});
  reject(/Deployed bytes differ/);
  console.log('Local developer gate rejects missing/incomplete evidence, changed source and inconsistent deployed bytes, removing stale success');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
