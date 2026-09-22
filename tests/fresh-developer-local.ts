import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

// Both failures must happen before any validator or deployment is contacted.
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
  fs.writeFileSync(path.join(dir,'acceptance.json'),JSON.stringify({passed:true,
    sourceCopy:{stagedRepository:dir,projectDirectory:dir,copiedFiles:[{...file,path:'program.bend'}]},
    tutorial:{changedProjectFiles:[file]},gateInputs:{},
    outputs:{elf:file,manifest:file,testReport:file,generatedClient:[file]}}));
  reject(/Offline acceptance input changed/);
  console.log('Local developer gate rejects missing evidence and changed source, removing stale success before deployment');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
