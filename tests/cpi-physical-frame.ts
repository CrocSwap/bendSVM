import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {digest,inventory} from '../verification/check-acyclic-lowering.ts';

// Maintained component gate. Full caller/physical-commit integration remains
// separate; this command cannot publish a whole-caller qualification receipt.
const directory='build/cpi-physical-frame',receipt=path.join(directory,'focused.json');
fs.mkdirSync(directory,{recursive:true});
const run=path.join(directory,'run-'+randomUUID());fs.mkdirSync(run);
if(fs.existsSync(receipt))fs.renameSync(receipt,path.join(run,'previous.json'));
fs.rmSync(receipt+'.pending',{force:true});
const sources=()=>{
 const files=inventory();
 for(const name of ['runtime/bend_cpi.h','runtime/cpi_abi.h','runtime/solana_min.h','tests/cpi-physical-native.c'])
  files[name]=digest(fs.readFileSync(name));
 return files;
};
const before=sources(),stages:any[]=[];
const python=process.env.PYTHON??'python3';
function child(name:string,script:string,args:string[],timeout:number) {
 const log=path.join(run,name+'.log'),fd=fs.openSync(log,'wx');
 let result:ReturnType<typeof spawnSync>;
 try{result=spawnSync(python,['-B',script,...args],{stdio:['ignore',fd,fd],timeout});}
 finally{fs.closeSync(fd);}
 stages.push({name,command:python,args:['-B',script,...args],exitCode:result.status,
  signal:result.signal,error:result.error?.message??null,log,logSha256:digest(fs.readFileSync(log))});
 fs.writeFileSync(path.join(run,'stages.json'),JSON.stringify(stages,null,2)+'\n');
 assert.ifError(result.error);assert.equal(result.signal,null,name+' signal');
 assert.equal(result.status,0,name+' failed; see '+log);
}
try {
 const proof=path.join(run,'proof'),native=path.join(run,'native');
 const dag=path.join(run,'dag.json'),audit=path.join(run,'audit.json'),controls=path.join(run,'report-controls.json');
 child('dag','tests/cpi-physical-dag.py',[dag],30000);
 child('proof','verification/cpi_physical/prove.py',[proof],900000);
 child('native','tests/cpi-physical-native.py',[native],180000);
 child('audit','verification/cpi_physical/audit_frame.py',[path.join(proof,'report.json'),path.join(native,'report.json'),audit],900000);
 child('reports','tests/cpi-physical-frame-reports.py',[path.join(proof,'report.json'),controls],60000);
 assert.deepEqual(sources(),before,'source drift during component gate');
 const read=(name:string)=>JSON.parse(fs.readFileSync(name,'utf8'));
 const checked=read(audit),hashed=read(dag),negative=read(controls);
 assert.equal(checked.passed,true);assert.equal(checked.componentOnly,true);assert.equal(checked.endToEndVerified,false);
 const model=read(path.join(proof,'report.json'));
 assert.equal(checked.queryReplays.length,33+model.serializationQueries.length);assert.equal(checked.descriptorStoreInstances,96);
 assert.equal(checked.nativeReplays.length,6);
 assert.equal(hashed.passed,true);assert.equal(hashed.distinctions.length,12);
 assert.equal(hashed.freshContextRoundtrips.length,6);assert.equal(hashed.refusals.length,5);
 assert.equal(negative.passed,true);assert.equal(negative.refusals.length,16);
 const artifacts=[path.join(proof,'report.json'),path.join(native,'report.json'),dag,audit,controls];
 const result={passed:true,componentOnly:true,endToEndVerified:false,run,sourceHashes:before,stages,
  artifacts:Object.fromEntries(artifacts.map(name=>[name,digest(fs.readFileSync(name))])),
  scope:'Fresh maintained memory-frame component, actual-helper native controls and SBF layout. Full source/caller/physical-commit qualification remains pending.'};
 fs.writeFileSync(receipt+'.pending',JSON.stringify(result,null,2)+'\n');fs.renameSync(receipt+'.pending',receipt);
 console.log('CPI physical-frame component, independent replay and permanent controls passed');
}catch(error){
 fs.rmSync(receipt,{force:true});fs.rmSync(receipt+'.pending',{force:true});
 fs.writeFileSync(path.join(run,'failure.json'),JSON.stringify({passed:false,error:String(error),stages},null,2)+'\n');
 throw error;
}
