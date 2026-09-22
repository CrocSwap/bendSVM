import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import type {InstructionPlan} from './program-client.ts';
import {ownDetachedProcessGroup} from './process-lifecycle.ts';

export type TestAccount={lamports:number;owner:string;executable:boolean;data:Uint8Array};
export type TestReceipt={ok:boolean;units:number;logs:string[];code?:number|null;error?:string;signature?:string};
export type ExpectedRejection=number|{application:number}|'invalid-selection';
export type LocalTestEvidence={
  endpoint:string;runtime:string;version:Record<string,unknown>;genesisHash:string;
  directory:string;receiptsPath:string;program:string;deploymentSignature:string|null;
  elfBytesMatched:number;elfBytes:number;zeroPaddingBytes:number;
};
export type TestProgram={
  program:string;payer:string;runtime:string;backend:'litesvm'|'local-rpc';receipts:TestReceipt[];
  localEvidence?:LocalTestEvidence&{receipts:unknown[];signatures:string[]};
  key(name:string):Promise<string>;account(address:string):Promise<TestAccount|null>;data(address:string):Promise<Uint8Array>;
  equal(actual:unknown,expected:unknown,message?:string):void;
  createAccounts(allocations:{address:string;bytes:number;owner?:string}[],initialize?:InstructionPlan|InstructionPlan[]):Promise<TestReceipt>;
  send(instruction:InstructionPlan|InstructionPlan[]):Promise<TestReceipt>;
  reject(instruction:InstructionPlan|InstructionPlan[],expected:ExpectedRejection):Promise<TestReceipt>;
  summary():{runtime:string;transactions:number;programCalls:number;successful:number;rejected:number;assertions:number;maxComputeUnits:number};
  close():Promise<void>;
};
function rejectionCode(expected:ExpectedRejection):number {
  if(expected==='invalid-selection')return 23;
  if(typeof expected==='number'){
    if(!Number.isInteger(expected)||expected<0||expected>0xffffffff)throw new Error('Expected a u32 rejection code');
    return expected;
  }
  if(!expected||!Number.isInteger(expected.application)||expected.application<0||expected.application>0xfffffeff)throw new Error('Invalid application rejection code');
  return 256+expected.application;
}
const repository=path.resolve(import.meta.dir,'..');
const serialize=(ix:InstructionPlan)=>({...ix,data:[...ix.data]});
type Transport={
  request:(value:unknown,timeoutMs?:number)=>Promise<any>;
  hello:any;
  close:()=>Promise<void>;
  key:(name:string)=>Promise<string>;
  localEvidence?:()=>LocalTestEvidence&{receipts:unknown[];signatures:string[]};
};
function testContext(transport:Transport):TestProgram {
  const {request,hello}=transport;
  const receipts:TestReceipt[]=[];const namedKeys=new Map<string,string>();
  namedKeys.set('$program',hello.program);
  let assertions=0,programCalls=0;
  let closed=false;
  const account=async(address:string):Promise<TestAccount|null>=>{
    const a=await request({op:'account',address});return a?{...a,data:new Uint8Array(a.data)}:null;
  };
  const successful=(r:TestReceipt)=>{receipts.push(r);assert(r.ok,`${r.error??'Transaction failed'}\n${r.logs.join('\n')}`);return r;};
  return {
    program:hello.program,payer:hello.payer,runtime:hello.runtime,backend:hello.backend??'litesvm',receipts,
    get localEvidence(){return transport.localEvidence?.();},
    async key(name:string):Promise<string>{
      if(namedKeys.has(name))return namedKeys.get(name)!;
      const address=await transport.key(name);namedKeys.set(name,address);return address;
    },
    account,
    async data(address:string):Promise<Uint8Array>{const a=await account(address);assert(a,`Missing account ${address}`);return a.data;},
    equal(actual:unknown,expected:unknown,message?:string){assertions++;assert.deepEqual(actual,expected,message);},
    async createAccounts(allocations:{address:string;bytes:number;owner?:string}[],initialize?:InstructionPlan|InstructionPlan[]) {
      const instructions=initialize?(Array.isArray(initialize)?initialize:[initialize]):[];
      programCalls+=instructions.filter(ix=>ix.program===hello.program).length;
      return successful(await request({op:'create',allocations:allocations.map(a=>({...a,owner:a.owner??hello.program})),instructions:instructions.map(serialize)}));
    },
    async send(instruction:InstructionPlan|InstructionPlan[]) {
      const instructions=Array.isArray(instruction)?instruction:[instruction];
      programCalls+=instructions.filter(ix=>ix.program===hello.program).length;
      return successful(await request({op:'send',instructions:instructions.map(serialize)}));
    },
    async reject(instruction:InstructionPlan|InstructionPlan[],expected:ExpectedRejection) {
      const code=rejectionCode(expected);
      const instructions=Array.isArray(instruction)?instruction:[instruction];
      programCalls+=instructions.filter(ix=>ix.program===hello.program).length;
      const addresses=[...new Set(instructions.flatMap(ix=>ix.accounts.map(a=>a.address)))].filter(a=>a!==hello.payer);
      const before=await Promise.all(addresses.map(account));
      const r:TestReceipt=await request({op:'send',instructions:instructions.map(serialize)});receipts.push(r);
      assert.equal(r.ok,false,'Expected transaction rejection');
      assert.equal(r.code,code,`${r.error}\n${r.logs.join('\n')}`);
      assert.deepEqual(await Promise.all(addresses.map(account)),before,'Rejected transaction changed application accounts');assertions+=3;
      return r;
    },
    summary(){return {runtime:hello.runtime,transactions:receipts.length,programCalls,successful:receipts.filter(r=>r.ok).length,rejected:receipts.filter(r=>!r.ok).length,assertions,maxComputeUnits:Math.max(0,...receipts.map(r=>r.units))};},
    async close(){if(closed)return;closed=true;await transport.close();},
  };
}
function lineProcess(executable:string,args:string[],cwd:string,defaultTimeoutMs=30000) {
  const child=spawn(executable,args,{cwd,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
  const cleanupGroup=ownDetachedProcessGroup(child);
  type Pending={resolve:(value:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>};
  const pending:Pending[]=[];let stderr='',closed=false;
  const failPending=(error:Error)=>{for(const p of pending.splice(0)){clearTimeout(p.timer);p.reject(error);}};
  const finished=new Promise<number|null>(resolve=>child.on('close',code=>{
    closed=true;failPending(new Error(`SBF test runner exited (${code}): ${stderr}`));resolve(code);
  })).then(async code=>{await cleanupGroup();return code;});
  child.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-16000);});
  const kill=()=>cleanupGroup();
  child.on('error',error=>{failPending(error);void kill();});
  child.stdin.on('error',error=>{failPending(new Error(`SBF test runner stdin failed: ${error.message}`));void kill();});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    const p=pending.shift();if(!p){failPending(new Error(`SBF test runner emitted unsolicited output: ${line.slice(0,200)}`));kill();return;}
    clearTimeout(p.timer);
    try{
      const response=JSON.parse(line);
      if(typeof response.success!=='boolean'||(response.success&&!Object.hasOwn(response,'value'))){throw new Error('Malformed SBF test runner response');}
      if(response.success)p.resolve(response.value);else p.reject(new Error(String(response.error??'SBF test runner request failed')));
    }catch(e){p.reject(e instanceof Error?e:new Error(String(e)));failPending(new Error('SBF test runner returned malformed JSON-lines output'));kill();}
  });
  const request=(value:unknown,timeoutMs=defaultTimeoutMs)=>new Promise<any>((resolve,reject)=>{
    if(closed){reject(new Error(`SBF test runner is closed: ${stderr}`));return;}
    const timer=setTimeout(()=>{
      const error=new Error('SBF test runner request timed out');
      failPending(error);void kill();
    },timeoutMs);
    pending.push({resolve,reject,timer});
    try{child.stdin.write(JSON.stringify(value)+'\n');}catch(error){
      failPending(error instanceof Error?error:new Error(String(error)));void kill();
    }
  });
  const close=async()=>{
    child.stdin.end();
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
      void kill().finally(()=>reject(new Error(`SBF test runner close timed out: ${stderr}`)));
    },15000);});
    try {const code=await Promise.race([finished,timeout]);if(code!==0)throw new Error(`SBF runner exited ${code}: ${stderr}`);}
    finally {if(timer)clearTimeout(timer);lines.close();}
  };
  return {child,request,close,finished,stderr:()=>stderr,kill};
}
async function buildLocalRunner() {
  const child=spawn('cargo',['build','--locked','--offline','--manifest-path','scripts/local-runner/Cargo.toml','--target-dir','target/local-runner'],
    {cwd:repository,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
  const cleanupGroup=ownDetachedProcessGroup(child);
  let output='',error='';
  child.stdout.on('data',data=>{output=(output+data.toString()).slice(-32000);});
  child.stderr.on('data',data=>{error=(error+data.toString()).slice(-32000);});
  let timedOut=false;
  const timer=setTimeout(()=>{
    timedOut=true;
    void cleanupGroup();
  },900000);
  const result=await new Promise<{code:number|null;failure?:Error}>((resolve)=>{
    child.once('error',failure=>resolve({code:null,failure}));
    child.once('close',code=>resolve({code}));
  }).finally(()=>clearTimeout(timer));
  await cleanupGroup();
  if(result.failure||result.code!==0)throw new Error(`Cannot build local RPC test runner${timedOut?' (15 minute timeout)':''}. Install the locked Cargo dependencies first with cargo fetch --locked --manifest-path scripts/local-runner/Cargo.toml.\n${result.failure?.message??''}${error}${output}`);
}
export async function startTestProgram(elf:string) {
  const build=spawnSync('cargo',['build','--locked','--offline','--manifest-path','scripts/test-runner/Cargo.toml','--target-dir','target'],{cwd:repository,encoding:'utf8'});
  if(build.status!==0)throw new Error(`Cannot build offline SBF test runner. Install the pinned dependencies first.\n${build.error??''}${build.stderr}`);
  const process=lineProcess(path.join(repository,'target/debug/bend-test-runner'),[],repository);
  try {
    const hello=await process.request({op:'hello'});
    let seed=0;
    const key=async(_name:string):Promise<string>=>process.request({op:'key',seed:++seed});
    const program=await key('$program');await process.request({op:'load',program,elf:path.resolve(elf)});
    return testContext({request:process.request,hello:{...hello,program,backend:'litesvm'},close:process.close,key});
  }catch(e){await process.kill();await process.finished;throw e;}
}
export async function startLocalRpcTestProgram(elf:string,endpoint:string,runDirectory:string) {
  if(endpoint!=='http://127.0.0.1:18899')throw new Error('Local RPC testing accepts only http://127.0.0.1:18899');
  await buildLocalRunner();
  fs.mkdirSync(runDirectory,{recursive:false,mode:0o700});
  fs.chmodSync(runDirectory,0o700);
  const executable=path.join(repository,'target/local-runner/debug/bend-local-runner');
  const process=lineProcess(executable,[endpoint,path.resolve(elf),path.resolve(runDirectory)],repository,240000);
  try {
    const hello=await process.request({op:'hello'},900000);
    const key=async(name:string):Promise<string>=>process.request({op:'key',name},60000);
    const localEvidence=()=>{
      const evidence=hello.localEvidence as LocalTestEvidence;
      const receipts=JSON.parse(fs.readFileSync(evidence.receiptsPath,'utf8')).receipts as unknown[];
      const signatures=receipts.map((receipt:any)=>receipt.signature).filter((signature:any):signature is string=>typeof signature==='string');
      return {...evidence,receipts,signatures};
    };
    return testContext({request:process.request,hello:{...hello,backend:'local-rpc'},close:process.close,key,localEvidence});
  }catch(e){await process.kill();await process.finished;throw e;}
}
