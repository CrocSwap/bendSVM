import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import type {InstructionPlan} from './program-client.ts';

export type TestAccount={lamports:number;owner:string;executable:boolean;data:Uint8Array};
export type TestReceipt={ok:boolean;units:number;logs:string[];code?:number|null;error?:string};
export type ExpectedRejection=number|{application:number}|'invalid-selection';
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
export async function startTestProgram(elf:string) {
  const build=spawnSync('cargo',['build','--locked','--offline','--manifest-path','scripts/test-runner/Cargo.toml','--target-dir','target'],{cwd:repository,encoding:'utf8'});
  if(build.status!==0)throw new Error(`Cannot build offline SBF test runner. Install the pinned dependencies first.\n${build.error??''}${build.stderr}`);
  const child=spawn(path.join(repository,'target/debug/bend-test-runner'),[],{stdio:['pipe','pipe','pipe']});
  type Pending={resolve:(value:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>};
  const pending:Pending[]=[];let stderr='',closed=false;
  const finished=new Promise<number|null>(resolve=>child.on('close',code=>{
    closed=true;for(const p of pending.splice(0)){clearTimeout(p.timer);p.reject(new Error(`SBF test runner exited (${code}): ${stderr}`));}resolve(code);
  }));
  child.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-16000);});
  child.on('error',error=>{for(const p of pending.splice(0)){clearTimeout(p.timer);p.reject(error);}});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    const p=pending.shift();if(!p){child.kill();return;}
    clearTimeout(p.timer);
    try{const response=JSON.parse(line);if(response.success)p.resolve(response.value);else p.reject(new Error(response.error));}
    catch(e){p.reject(e instanceof Error?e:new Error(String(e)));}
  });
  const request=(value:unknown)=>new Promise<any>((resolve,reject)=>{
    if(closed){reject(new Error(`SBF test runner is closed: ${stderr}`));return;}
    const timer=setTimeout(()=>{child.kill();reject(new Error('SBF test runner request timed out'));},30000);
    pending.push({resolve,reject,timer});child.stdin.write(JSON.stringify(value)+'\n');
  });
  const receipts:TestReceipt[]=[];const namedKeys=new Map<string,string>();let seed=0;
  let assertions=0,programCalls=0;
  try {
    const hello=await request({op:'hello'});
    const key=async(name:string):Promise<string>=>{
      if(namedKeys.has(name))return namedKeys.get(name)!;
      const address=await request({op:'key',seed:++seed});namedKeys.set(name,address);return address;
    };
    const program=await key('$program');await request({op:'load',program,elf:path.resolve(elf)});
    const account=async(address:string):Promise<TestAccount|null>=>{
      const a=await request({op:'account',address});return a?{...a,data:new Uint8Array(a.data)}:null;
    };
    const successful=(r:TestReceipt)=>{receipts.push(r);assert(r.ok,`${r.error??'Transaction failed'}\n${r.logs.join('\n')}`);return r;};
    return {
      program,payer:hello.payer as string,runtime:hello.runtime as string,receipts,key,account,
      async data(address:string):Promise<Uint8Array>{const a=await account(address);assert(a,`Missing account ${address}`);return a.data;},
      equal(actual:unknown,expected:unknown,message?:string){assertions++;assert.deepEqual(actual,expected,message);},
      async createAccounts(allocations:{address:string;bytes:number;owner?:string}[],initialize?:InstructionPlan|InstructionPlan[]) {
        const instructions=initialize?(Array.isArray(initialize)?initialize:[initialize]):[];
        programCalls+=instructions.filter(ix=>ix.program===program).length;
        return successful(await request({op:'create',allocations:allocations.map(a=>({...a,owner:a.owner??program})),instructions:instructions.map(serialize)}));
      },
      async send(instruction:InstructionPlan|InstructionPlan[]) {
        const instructions=Array.isArray(instruction)?instruction:[instruction];
        programCalls+=instructions.filter(ix=>ix.program===program).length;
        return successful(await request({op:'send',instructions:instructions.map(serialize)}));
      },
      async reject(instruction:InstructionPlan|InstructionPlan[],expected:ExpectedRejection) {
        const code=rejectionCode(expected);
        const instructions=Array.isArray(instruction)?instruction:[instruction];
        programCalls+=instructions.filter(ix=>ix.program===program).length;
        const addresses=[...new Set(instructions.flatMap(ix=>ix.accounts.map(a=>a.address)))].filter(a=>a!==hello.payer);
        const before=await Promise.all(addresses.map(account));
        const r:TestReceipt=await request({op:'send',instructions:instructions.map(serialize)});receipts.push(r);
        assert.equal(r.ok,false,'Expected transaction rejection');
        assert.equal(r.code,code,`${r.error}\n${r.logs.join('\n')}`);
        assert.deepEqual(await Promise.all(addresses.map(account)),before,'Rejected transaction changed application accounts');assertions+=3;
        return r;
      },
      summary(){return {runtime:hello.runtime,transactions:receipts.length,programCalls,successful:receipts.filter(r=>r.ok).length,rejected:receipts.filter(r=>!r.ok).length,assertions,maxComputeUnits:Math.max(0,...receipts.map(r=>r.units))};},
      async close(){child.stdin.end();const code=await finished;lines.close();if(code!==0)throw new Error(`SBF runner exited ${code}: ${stderr}`);},
    };
  }catch(e){child.kill();await finished;lines.close();throw e;}
}
export type TestProgram=Awaited<ReturnType<typeof startTestProgram>>;
