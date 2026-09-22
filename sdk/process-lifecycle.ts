import type {ChildProcess} from 'node:child_process';

type ParentSignal='SIGINT'|'SIGTERM';
type OwnedGroup={pid:number;child:ChildProcess;cleanup?:Promise<void>};

const groups=new Map<number,OwnedGroup>();
let installed=false,signalHandled=false;

function signalGroup(pid:number,signal:NodeJS.Signals):void {
  try {
    if(process.platform==='win32')groups.get(pid)?.child.kill(signal);
    else process.kill(-pid,signal);
  }catch{}
}
function groupExists(pid:number):boolean {
  try {
    if(process.platform==='win32'){
      const child=groups.get(pid)?.child;
      return child!==undefined&&child.exitCode===null&&child.signalCode===null;
    }
    process.kill(-pid,0);return true;
  }catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
}
async function waitForGroupExit(pid:number,timeoutMs:number):Promise<boolean> {
  const deadline=Date.now()+timeoutMs;
  while(groupExists(pid)){
    if(Date.now()>=deadline)return false;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  return true;
}
async function terminateGroup(group:OwnedGroup):Promise<void> {
  signalGroup(group.pid,'SIGTERM');
  if(await waitForGroupExit(group.pid,1000))return;
  signalGroup(group.pid,'SIGKILL');
  await waitForGroupExit(group.pid,1000);
}
function removeHooksIfUnused():void {
  if(groups.size||!installed||signalHandled)return;
  process.off('SIGINT',onSignalInt);
  process.off('SIGTERM',onSignalTerm);
  process.off('beforeExit',onBeforeExit);
  process.off('exit',onExit);
  installed=false;
}
function ensureHooks():void {
  if(installed)return;
  process.on('SIGINT',onSignalInt);
  process.on('SIGTERM',onSignalTerm);
  process.on('beforeExit',onBeforeExit);
  process.on('exit',onExit);
  installed=true;
}
function cleanupGroup(group:OwnedGroup):Promise<void> {
  if(group.cleanup)return group.cleanup;
  group.cleanup=terminateGroup(group).finally(()=>{
    if(groups.get(group.pid)===group)groups.delete(group.pid);
    removeHooksIfUnused();
  });
  return group.cleanup;
}
async function cleanupAll():Promise<void> {
  await Promise.all([...groups.values()].map(cleanupGroup));
}
function onSignal(signal:ParentSignal):void {
  if(signalHandled)return;
  signalHandled=true;
  const code=128+(signal==='SIGINT'?2:15);
  void cleanupAll().finally(()=>process.exit(code));
}
function onSignalInt():void {onSignal('SIGINT');}
function onSignalTerm():void {onSignal('SIGTERM');}
function onBeforeExit():void {
  if(groups.size)void cleanupAll();
}
function onExit():void {
  for(const group of groups.values())signalGroup(group.pid,'SIGKILL');
}

/** Track a detached process group until its caller has completed or aborted it. */
export function ownDetachedProcessGroup(child:ChildProcess):()=>Promise<void> {
  const pid=child.pid;
  if(pid===undefined)return async()=>{};
  const group:OwnedGroup={pid,child};
  groups.set(pid,group);
  ensureHooks();
  return ()=>cleanupGroup(group);
}
