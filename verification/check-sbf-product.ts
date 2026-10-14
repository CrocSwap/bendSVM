import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dir,'..');
const output=path.resolve(process.env.SBF_PRODUCT_OUTPUT??path.join(root,'build/sbf-product'));
const attempt=path.join(output,`wrapper-${randomUUID()}`),latest=path.join(output,'latest.json');
fs.mkdirSync(attempt,{recursive:true});
if(fs.existsSync(latest))fs.renameSync(latest,path.join(attempt,'previous-latest.json'));
const hash=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
try {
 const child=spawnSync(process.env.PYTHON??'python3',['-B',path.join(import.meta.dir,'check-sbf-product.py')],{cwd:root,env:{...process.env,SBF_PRODUCT_OUTPUT:output},encoding:'utf8',timeout:900000,maxBuffer:8*1024*1024});
 fs.writeFileSync(path.join(attempt,'driver.log'),(child.stdout??'')+(child.stderr??'')+(child.error?String(child.error):''));
 assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,`SBF qualification failed; ${attempt}/driver.log`);
 const result=JSON.parse(child.stdout),pointer=JSON.parse(fs.readFileSync(latest,'utf8'));
 assert.equal(result.passed,true);assert.equal(result.runRoot,pointer.runRoot);assert.equal(result.reportSha256,pointer.reportSha256);
 const reportPath=path.join(pointer.runRoot,'report.json');assert.equal(hash(reportPath),pointer.reportSha256);
 const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));assert.equal(report.passed,true);assert.equal(report.endToEndVerified,false);
 for(const key of ['sourceHashes','stagedSourceHashes','externalHashes','logs']) {
  assert.ok(Object.keys(report[key]).length>0);
  for(const [p,h] of Object.entries(report[key]))assert.equal(hash(p),h,`${key} drift`);
 }
 assert.equal(hash(report.terminal),report.terminalSha256);assert.equal(hash(report.initialManifest),report.initialManifestSha256);
 const terminal=JSON.parse(fs.readFileSync(report.terminal,'utf8'));
 assert.equal(terminal.passed,true);assert.equal(terminal.endToEndVerified,false);assert.equal(terminal.phases.length,7);assert.equal(Object.keys(terminal.reports).length,9);
 fs.writeFileSync(path.join(attempt,'accepted.json'),JSON.stringify({passed:true,report:reportPath,reportSha256:hash(reportPath),wrapperSha256:hash(import.meta.path)},null,2)+'\n');
 console.log(`Conditional SBF product gate passed: fresh source/build, machine proofs and 78 LiteSVM checkpoints; ${reportPath}`);
} catch(error) {
 if(fs.existsSync(latest))fs.renameSync(latest,path.join(attempt,'failed-latest.json'));
 fs.writeFileSync(path.join(attempt,'failure.json'),JSON.stringify({passed:false,error:String(error)},null,2)+'\n');
 throw error;
}
