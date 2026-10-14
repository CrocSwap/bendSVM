import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {digest,inventory} from './check-acyclic-lowering.ts';

const directory='build/cpi-physical',receipt=path.join(directory,'fresh-receipt.json');
const hash=(name:string)=>digest(fs.readFileSync(name));
export function physicalSources() {
 const files=inventory();
 const walk=(directory:string)=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
  const name=path.join(directory,entry.name);
  if(entry.isDirectory())walk(name);else if(/\.(json|c|h)$/.test(name))files[name]=hash(name);
 }};
 for(const directory of ['compiler','verification','runtime','tests'])walk(directory);
 return files;
}
export function checkCpiPhysical() {
 fs.mkdirSync(directory,{recursive:true});
 const run=path.join(directory,'run-'+randomUUID());fs.mkdirSync(run);
 if(fs.existsSync(receipt))fs.renameSync(receipt,path.join(run,'previous.json'));
 fs.rmSync(receipt+'.pending',{force:true});
 const sourceHashes=physicalSources(),stages:any[]=[];
 fs.writeFileSync(path.join(run,'inputs.json'),JSON.stringify({inputs:sourceHashes},null,2)+'\n');
 const python=process.env.PYTHON??'python3';
 function child(name:string,command:string,args:string[],timeout:number) {
  const log=path.join(run,name+'.log'),fd=fs.openSync(log,'wx');
  let result:ReturnType<typeof spawnSync>;
  try{result=spawnSync(command,args,{stdio:['ignore',fd,fd],timeout});}finally{fs.closeSync(fd);}
  stages.push({name,command,args,exitCode:result.status,signal:result.signal,error:result.error?.message??null,
   log,logSha256:hash(log)});
  fs.writeFileSync(path.join(run,'stages.json'),JSON.stringify(stages,null,2)+'\n');
  assert.ifError(result.error);assert.equal(result.signal,null,name+' signal');
  assert.equal(result.status,0,name+' failed; see '+log);
 }
 function evidence(pointer:string) {
  const p=JSON.parse(fs.readFileSync(path.join(run,pointer),'utf8'));
  assert.equal(hash(p.report),p.sha256,'evidence drift');
  const report=JSON.parse(fs.readFileSync(p.report,'utf8'));assert.equal(report.passed,true);
  for(const [name,expected] of Object.entries(report.bindings??{}))assert.equal(hash(name),expected,'binding drift '+name);
  return {artifact:p.report,sha256:p.sha256,report};
 }
 try {
  child('component',process.execPath,['tests/cpi-physical-frame.ts'],1800000);
  child('typed-dag',python,['-B','tests/cpi-physical-typed-dag.py',path.join(run,'typed-dag.json')],60000);
  child('witness-grounding',python,['-B','tests/cpi-physical-witness.py',path.join(run,'witness-grounding.json')],60000);
  child('projection-model',python,['-B','tests/cpi-physical-projections.py',path.join(run,'projection-model')],180000);
  child('export',process.execPath,['verification/export-cpi-caller.ts',path.join(run,'fixtures')],180000);
  child('profiles',process.execPath,['verification/cpi-caller-profiles.ts',path.join(run,'fixtures/input.json'),path.join(run,'profiles.json')],30000);
  child('native-profiles',process.execPath,['verification/cpi-physical-native-profiles.ts',run],30000);
  child('native',python,['-B','verification/cpi_physical/native.py',run],180000);
  child('native-audit',python,['-B','verification/cpi_physical/audit_native.py',run],180000);
  child('connection',python,['-B','verification/cpi_physical/connect.py',run],7200000);
  child('connection-audit',python,['-B','verification/cpi_physical/audit.py',run],7200000);
  assert.deepEqual(physicalSources(),sourceHashes,'source drift during qualification');
  const native=evidence('native-audit.json'),connection=evidence('connection-audit.json');
  assert.equal(native.report.replayed.length,18);assert.equal(native.report.scenarios,108);
  assert.equal(connection.report.fixtures,3);assert.equal(connection.report.sourcePromoted,true);
  assert.equal(connection.report.endToEndVerified,false);assert.equal(connection.report.reportControls.length,17);
  // The component's public pointer changes during later controls/restoration.
  // Preserve this run's receipt bytes so its evidence path stays reviewable.
  const component=path.join(run,'component-receipt.json');
  fs.copyFileSync('build/cpi-physical-frame/focused.json',component,fs.constants.COPYFILE_EXCL);
  const result={passed:true,endToEndVerified:false,run,sourceHashes,stages,
   inputArtifact:path.join(run,'fixtures/input.json'),inputSha256:hash(path.join(run,'fixtures/input.json')),
   nativeAuditArtifact:native.artifact,nativeAuditSha256:native.sha256,
   connectionAuditArtifact:connection.artifact,connectionAuditSha256:connection.sha256,
   componentArtifact:component,componentSha256:hash(component),
   scope:'Conditional maintained actual source/caller, private helper workspace, descriptor refresh, pending sources and physical commit qualification. No compiler/LLVM/SBF/runtime or external rollback theorem.'};
  fs.writeFileSync(receipt+'.pending',JSON.stringify(result,null,2)+'\n');fs.renameSync(receipt+'.pending',receipt);
  console.log('Maintained CPI caller/physical helper/commit qualification and audits passed');
  return result;
 }catch(error){
  fs.rmSync(receipt,{force:true});fs.rmSync(receipt+'.pending',{force:true});
  fs.writeFileSync(path.join(run,'failure.json'),JSON.stringify({passed:false,error:String(error),stages},null,2)+'\n');
  throw error;
 }
}
if(import.meta.main)checkCpiPhysical();
