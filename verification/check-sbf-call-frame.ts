import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const hash=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export async function main(){
 const base=path.resolve(process.env.SBF_FRAME_OUTPUT??'build/sbf-call-frame'),attempt=path.join(base,'prerequisites',randomUUID()),receipt=path.join(base,'fresh-receipt.json');
 fs.mkdirSync(attempt,{recursive:true});if(fs.existsSync(receipt))fs.renameSync(receipt,path.join(attempt,'previous.json'));
 function run(name:string,args:string[],extra:Record<string,string>={}){
  const c=spawnSync(args[0],args.slice(1),{env:{...process.env,...extra},encoding:'utf8',timeout:960000,maxBuffer:8*1024*1024});
  const log=path.join(attempt,name+'.log');fs.writeFileSync(log,(c.stdout??'')+(c.stderr??'')+(c.error?String(c.error):''));
  assert.ifError(c.error);assert.equal(c.signal,null);assert.equal(c.status,0,log);return c.stdout;
 }
 const handler=path.join(attempt,'handler');
 run('handler',[process.execPath,'verification/check-sbf-handler.ts'],{SBF_HANDLER_OUTPUT:handler});
 const pointer=JSON.parse(fs.readFileSync(path.join(handler,'latest.json'),'utf8')),report=path.join(pointer.runRoot,'report.json');
 assert.equal(hash(report),pointer.reportSha256);
 fs.writeFileSync(path.join(base,'handler-prerequisite.json'),JSON.stringify({qualification:{report,sha256:hash(report)}},null,2)+'\n');
 const result=JSON.parse(run('frame',[process.env.PYTHON??'python3','-B','verification/sbf_call_frame/qualification/controller.py'],{SBF_FRAME_OUTPUT:base}));
 assert.deepEqual(JSON.parse(fs.readFileSync(receipt,'utf8')),result);assert.equal(result.passed,true);
 for(const stem of ['input','manifest','accepted'])assert.equal(hash(result[stem]),result[stem+'Sha256']);
 return result;
}
if(import.meta.main)await main();
