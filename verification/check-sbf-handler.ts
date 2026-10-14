import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dir,'..');
const output=path.resolve(process.env.SBF_HANDLER_OUTPUT??path.join(root,'build/sbf-handler'));
const attempt=path.join(output,`wrapper-${randomUUID()}`),latest=path.join(output,'latest.json');
fs.mkdirSync(attempt,{recursive:true});
if(fs.existsSync(latest))fs.renameSync(latest,path.join(attempt,'previous-latest.json'));
const hash=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
try {
 const child=spawnSync(process.env.PYTHON??'python3',['-B',path.join(import.meta.dir,'check-sbf-handler.py')],{cwd:root,env:{...process.env,SBF_HANDLER_OUTPUT:output},encoding:'utf8',timeout:900000,maxBuffer:8*1024*1024});
 fs.writeFileSync(path.join(attempt,'driver.log'),(child.stdout??'')+(child.stderr??'')+(child.error?String(child.error):''));
 assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,`SBF qualification failed; ${attempt}/driver.log`);
 const result=JSON.parse(child.stdout),pointer=JSON.parse(fs.readFileSync(latest,'utf8'));
 assert.equal(result.passed,true);assert.equal(result.runRoot,pointer.runRoot);assert.equal(result.reportSha256,pointer.reportSha256);
 const reportPath=path.join(pointer.runRoot,'report.json');assert.equal(hash(reportPath),pointer.reportSha256);
 const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));assert.equal(report.passed,true);assert.equal(report.endToEndVerified,false);
 for(const key of ['sourceHashes','stagedSourceHashes','externalHashes','reports','logs']) {
  assert.ok(Object.keys(report[key]).length>0);
  for(const [p,h] of Object.entries(report[key]))assert.equal(hash(p),h,`${key} drift`);
 }
 assert.equal(Object.keys(report.reports).length,17);assert.equal(report.phases.length,17);
 assert.equal(hash(report.quotientReport),report.quotientReportSha256);
 assert.equal(hash(report.modelReport),report.modelReportSha256);
 assert.equal(hash(report.zeroFillReport),report.zeroFillReportSha256);
 assert.equal(hash(report.zeroFillConnection),report.zeroFillConnectionSha256);
 const clear=JSON.parse(fs.readFileSync(report.zeroFillConnection,'utf8'));
 assert.equal(clear.passed,true);assert.equal(clear.endToEndVerified,false);assert.equal(clear.callSites.length,4);
 const phases=JSON.parse(fs.readFileSync(path.join(import.meta.dir,'sbf_handler/phases.json'),'utf8'));
 assert.deepEqual(report.phases.map((p:any)=>p.script),phases.map((p:any)=>p.script));
 assert.deepEqual(report.phases.map((p:any)=>p.report),Object.keys(report.reports));
 for(const phase of report.phases)assert.equal(phase.result.passed,true);
 fs.writeFileSync(path.join(attempt,'accepted.json'),JSON.stringify({passed:true,report:reportPath,reportSha256:hash(reportPath),wrapperSha256:hash(import.meta.path)},null,2)+'\n');
 console.log(`Conditional SBF handler gate passed: fresh source/build, native path/output checks and whole-output VM comparisons; ${reportPath}`);
} catch(error) {
 if(fs.existsSync(latest))fs.renameSync(latest,path.join(attempt,'failed-latest.json'));
 fs.writeFileSync(path.join(attempt,'failure.json'),JSON.stringify({passed:false,error:String(error)},null,2)+'\n');
 throw error;
}
