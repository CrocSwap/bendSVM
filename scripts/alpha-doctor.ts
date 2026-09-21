import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {BEND_COMMIT,sbfTools} from './build.ts';

const repository=path.resolve(import.meta.dir,'..');
const expectedBun='1.4.2';
const expectedTypeScript='5.2.2';
const expectedRust='1.92.0';
const refinement=process.argv.includes('--refinement');
type Check={name:string;required:boolean;ok:boolean;detail:string;reuse?:string};
const checks:Check[]=[];
const add=(name:string,required:boolean,ok:boolean,detail:string,reuse?:string)=>checks.push({name,required,ok,detail,...reuse?{reuse}:{}});
const command=(name:string,args:string[],cwd=repository)=>{
  const result=spawnSync(name,args,{cwd,encoding:'utf8',env:{...process.env,BEND_NO_TELEMETRY:'1'}});
  return {ok:!result.error&&result.status===0,output:`${result.stdout??''}${result.stderr??''}`.trim(),error:result.error?.message};
};
const which=(name:string)=>command('sh',['-c',`command -v "$1"`,'doctor',name]);
const version=(name:string,args:string[],pattern:RegExp,required=true)=>{
  const result=command(name,args);
  const line=result.output.split('\n').find(Boolean)??result.error??'not found';
  add(name,required,result.ok&&pattern.test(result.output),line);
};
const file=(name:string,target:string,required=true,reuse?:string)=>{
  const ok=fs.existsSync(target)&&fs.statSync(target).isFile();
  add(name,required,ok,ok?target:`missing ${target}`,reuse);
};

version('node',['--version'],/^v(?:2[0-9]|3[0-9])\./);
version('npm',['--version'],/^\d+\./);
version('git',['--version'],/^git version /);
const bun=path.join(repository,'node_modules/.bin/bun');
if(fs.existsSync(bun)){
  const result=command(bun,['--version']);
  add('bun',true,result.ok&&result.output===expectedBun,result.output||result.error||'not found',`npm package bun@${expectedBun}`);
}else add('bun',true,false,`missing ${bun}`);
version('cargo',['--version'],new RegExp(`\\b${expectedRust.replaceAll('.','\\.')}\\b`));
version('rustc',['--version'],new RegExp(`\\b${expectedRust.replaceAll('.','\\.')}\\b`));
version('curl',['--version'],/^curl /);
version('clang',['--version'],/clang version|Apple clang version/);
version('python3',['--version'],/^Python 3\./,refinement);

const tsc=path.join(repository,'node_modules/typescript/lib/tsc.js');
file('typescript',tsc,true,`npm package typescript@${expectedTypeScript}; no host cache`);
if(fs.existsSync(tsc)){
  const result=command(process.execPath,[tsc,'--version']);
  add('tsc-version',true,result.ok&&result.output===`Version ${expectedTypeScript}`,result.output||result.error||'not found',`node_modules/typescript/lib/tsc.js`);
}

const tools=sbfTools();
const toolReuse=process.env.SBF_TOOLS?`SBF_TOOLS=${tools}`:`default cache ${tools}`;
file('sbf-clang',path.join(tools,'clang'),true,toolReuse);
file('sbf-ld.lld',path.join(tools,'ld.lld'),true,toolReuse);
file('sbf-llvm-readelf',path.join(tools,'llvm-readelf'),true,toolReuse);
if(fs.existsSync(path.join(tools,'clang'))){
  const result=command(path.join(tools,'clang'),['--version']);
  add('sbf-clang-version',true,result.ok&&/20\.1\.7/.test(result.output)&&/anza-xyz/.test(result.output),result.output.split('\n')[0]??result.error??'not found',toolReuse);
}

const bendHead=command('git',['-C','.deps/bend','rev-parse','HEAD']);
const bendStatus=command('git',['-C','.deps/bend','status','--porcelain']);
add('bend-checkout',true,bendHead.ok&&bendHead.output===BEND_COMMIT&&bendStatus.ok&&!bendStatus.output,`${bendHead.output||bendHead.error||'missing'}${bendStatus.output?' (dirty)':''}`,`.deps/bend at ${BEND_COMMIT}`);
for(const manifest of ['scripts/test-runner/Cargo.toml','scripts/live-queue/Cargo.toml']){
  const result=command('cargo',['metadata','--locked','--offline','--no-deps','--manifest-path',manifest]);
  add(`cargo-${path.basename(path.dirname(manifest))}`,true,result.ok,result.ok?'locked offline metadata available':result.error??result.output);
}

const python=process.env.PYTHON||'python3';
const z3=command(python,['-c','import z3; print(z3.get_version_string())']);
const z3Detail=z3.ok&&z3.output==='5.1.0'
  ? z3.output
  : `${z3.output||z3.error||'not found'}; install with: python3 -m venv .deps/refinement-venv && .deps/refinement-venv/bin/python -m pip install z3-solver==5.1.0`;
add('python-z3',refinement,z3.ok&&z3.output==='5.1.0',z3Detail,
  `interpreter ${python}; optional unless --refinement, pinned z3-solver==5.1.0`);

for(const name of ['solana','solana-test-validator']){
  const found=which(name);
  if(found.ok)version(name,['--version'],name==='solana'?/^solana-cli /:/^solana-test-validator /,false);
  else add(name,false,false,'not found (required only for live deployment)');
}

if(process.argv.includes('--live')){
  for(const c of checks.filter(c=>c.name==='solana'||c.name==='solana-test-validator'))c.required=true;
  const rpc=command('curl',['--fail-with-body','--silent','--show-error','--max-time','15','https://api.devnet.solana.com','-H','Content-Type: application/json','--data-binary','{"jsonrpc":"2.0","id":1,"method":"getVersion","params":[]}']);
  add('devnet-rpc',true,rpc.ok&&rpc.output.includes('solana-core'),rpc.ok?'getVersion succeeded':rpc.error??rpc.output);
}

const failed=checks.filter(c=>c.required&&!c.ok);
const report={version:1,generatedAt:new Date().toISOString(),repository,host:{platform:os.platform(),arch:os.arch()},
  refinementRequested:refinement,checks,passed:failed.length===0};
if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
else{
  for(const c of checks)console.log(`${c.ok?'PASS':'FAIL'} ${c.required?'required':'optional'} ${c.name}: ${c.detail}${c.reuse?` [reuse: ${c.reuse}]`:''}`);
  console.log(failed.length?`Doctor failed: ${failed.length} required prerequisite(s) missing or mismatched.`:'Doctor passed: supported external-alpha prerequisites are available.');
}
const outputIndex=process.argv.indexOf('--write');
if(outputIndex>=0&&process.argv[outputIndex+1]){
  const target=path.resolve(process.argv[outputIndex+1]);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');
}
if(failed.length)process.exitCode=1;
