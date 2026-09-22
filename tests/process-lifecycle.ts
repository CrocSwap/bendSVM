import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const lifecycleUrl=pathToFileURL(path.resolve(import.meta.dir,'../sdk/process-lifecycle.ts')).href;
const fakeChildSource=`
  const fs=await import('node:fs');
  const {spawn}=await import('node:child_process');
  const role=process.env.FAKE_ROLE;
  const dir=process.env.TEST_DIR;
  fs.writeFileSync(dir+'/'+role+'.started','ready');
  const stop=signal=>{
    fs.appendFileSync(dir+'/'+role+'.signals',signal+String.fromCharCode(10));
    setTimeout(()=>process.exit(0),20);
  };
  process.on('SIGINT',()=>stop('SIGINT'));
  process.on('SIGTERM',()=>stop('SIGTERM'));
  if(role==='cargo'||role==='runner'){
    const childRole=role==='cargo'?'cargo-worker':'solana-cli';
    spawn(process.execPath,['-e',${JSON.stringify(`
      const fs=await import('node:fs');
      const role=process.env.FAKE_ROLE;
      const dir=process.env.TEST_DIR;
      fs.writeFileSync(dir+'/'+role+'.started','ready');
      const stop=signal=>{fs.appendFileSync(dir+'/'+role+'.signals',signal+String.fromCharCode(10));setTimeout(()=>process.exit(0),20)};
      process.on('SIGINT',()=>stop('SIGINT'));
      process.on('SIGTERM',()=>stop('SIGTERM'));
      setInterval(()=>{},1000);
    `)}],{stdio:'ignore',env:{...process.env,FAKE_ROLE:childRole}});
  }
  setInterval(()=>{},1000);
`;
const harnessSource=`
  const fs=await import('node:fs');
  const {spawn}=await import('node:child_process');
  const {ownDetachedProcessGroup}=await import(process.env.LIFECYCLE_MODULE);
  const dir=process.env.TEST_DIR;
  const stage=process.env.TEST_STAGE;
  const role=stage==='build'?'cargo':'runner';
  const managed=spawn(process.execPath,['-e',${JSON.stringify(fakeChildSource)}],{
    detached:true,stdio:'ignore',env:{...process.env,FAKE_ROLE:role}
  });
  const cleanup=ownDetachedProcessGroup(managed);
  const unrelated=spawn(process.execPath,['-e',${JSON.stringify(fakeChildSource)}],{
    detached:true,stdio:'ignore',env:{...process.env,FAKE_ROLE:'unrelated'}
  });
  fs.writeFileSync(dir+'/pids.json',JSON.stringify({managedPid:managed.pid,unrelatedPid:unrelated.pid}));
  const waitFor=async files=>{
    const end=Date.now()+5000;
    while(Date.now()<end){if(files.every(file=>fs.existsSync(dir+'/'+file)))return;await new Promise(r=>setTimeout(r,10));}
    throw new Error('Timed out waiting for fake processes: '+files.join(', '));
  };
  await waitFor([role+'.started','unrelated.started',stage==='build'?'cargo-worker.started':'solana-cli.started']);
  fs.writeFileSync(dir+'/ready.json',JSON.stringify({managedPid:managed.pid,unrelatedPid:unrelated.pid}));
  if(process.env.TEST_MODE==='normal'){
    const before=process.listenerCount('SIGINT');
    await cleanup();
    if(process.listenerCount('SIGINT')!==before-1)throw new Error('SIGINT lifecycle handler remained installed');
    fs.writeFileSync(dir+'/normal-done','done');
    process.exit(0);
  }
  if(process.env.TEST_MODE==='exit')process.exit(0);
  setInterval(()=>{},1000);
`;

async function waitFor(predicate:()=>boolean,description:string,timeoutMs=5000):Promise<void> {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,15));}
  throw new Error(`Timed out waiting for ${description}`);
}
function groupExists(pid:number):boolean {
  try{process.kill(-pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
}
async function runScenario(stage:'build'|'startup',signal:'SIGINT'|'SIGTERM'|'normal'|'exit'):Promise<void> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bend-process-lifecycle-'));
  let managedPid:number|undefined,unrelatedPid:number|undefined;
  let harness:ReturnType<typeof spawn>|undefined;
  try{
    harness=spawn(process.execPath,['-e',harnessSource],{
      stdio:['ignore','ignore','pipe'],
      env:{...process.env,LIFECYCLE_MODULE:lifecycleUrl,TEST_DIR:dir,TEST_STAGE:stage,TEST_MODE:signal},
    });
    let stderr='';harness.stderr.on('data',data=>stderr+=data.toString());
    const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>harness!.once('close',(code,childSignal)=>resolve({code,signal:childSignal})));
    await waitFor(()=>fs.existsSync(path.join(dir,'pids.json'))||harness!.exitCode!==null,`${stage} fake process creation`);
    if(fs.existsSync(path.join(dir,'pids.json'))){
      const pids=JSON.parse(fs.readFileSync(path.join(dir,'pids.json'),'utf8')) as {managedPid:number;unrelatedPid:number};
      managedPid=pids.managedPid;unrelatedPid=pids.unrelatedPid;
    }
    await waitFor(()=>fs.existsSync(path.join(dir,'ready.json'))||harness!.exitCode!==null,`${stage} fake process startup`);
    if(signal!=='normal'&&signal!=='exit')assert.equal(harness.exitCode,null,`Lifecycle harness failed to start: ${stderr}`);
    let ready:{managedPid:number;unrelatedPid:number}|undefined;
    if(fs.existsSync(path.join(dir,'ready.json'))){
      ready=JSON.parse(fs.readFileSync(path.join(dir,'ready.json'),'utf8')) as {managedPid:number;unrelatedPid:number};
      managedPid=ready.managedPid;unrelatedPid=ready.unrelatedPid;
    }
    if(signal==='normal'){
      if(harness.exitCode===null)await waitFor(()=>fs.existsSync(path.join(dir,'normal-done')),'normal process-group close');
    }else if(signal==='exit'){
      assert(ready,'Exit-hook harness did not reach its live-group point');
    }else{
      process.kill(harness.pid!,signal);
    }
    let timeout:ReturnType<typeof setTimeout>|undefined;
    const result=await Promise.race([
      exited,
      new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error(`Harness did not exit after ${signal}`)),5000);}),
    ]).finally(()=>{if(timeout)clearTimeout(timeout);});
    assert.equal(result.signal,null,`Harness died from an unexpected signal: ${stderr}`);
    assert.equal(result.code,signal==='SIGINT'?130:signal==='SIGTERM'?143:0,`Unexpected harness exit: ${stderr}`);
    const descendant=stage==='build'?'cargo-worker':'solana-cli';
    if(signal==='exit'){
      for(const role of [stage==='build'?'cargo':'runner',descendant])
        assert.equal(fs.existsSync(path.join(dir,role+'.signals')),false,`${role} should be force-killed by synchronous exit cleanup`);
    }else for(const role of [stage==='build'?'cargo':'runner',descendant]){
      const recorded=fs.readFileSync(path.join(dir,role+'.signals'),'utf8');
      assert.match(recorded,/SIGTERM\n/,`${role} did not receive group termination`);
    }
    assert(ready,'Lifecycle harness exited before writing readiness evidence');
    await waitFor(()=>!groupExists(ready.managedPid),`${stage} process group termination`);
    assert.equal(groupExists(unrelatedPid),true,'Cleanup touched the unrelated process group');
  }finally{
    for(const pid of [managedPid,unrelatedPid])if(pid!==undefined){
      try{process.kill(-pid,'SIGKILL');}catch{}
      await waitFor(()=>!groupExists(pid),`test fixture group ${pid} cleanup`,1000).catch(()=>{});
    }
    if(harness&&harness.exitCode===null){try{process.kill(harness.pid!,'SIGKILL');}catch{}}
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

for(const stage of ['build','startup'] as const){
  for(const signal of ['SIGINT','SIGTERM'] as const)await runScenario(stage,signal);
  await runScenario(stage,'normal');
  await runScenario(stage,'exit');
}
console.log('Detached process-group lifecycle checks passed (build/startup, signals, normal close, exit cleanup).');
