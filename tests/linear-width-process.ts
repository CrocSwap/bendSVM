import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {digest} from '../verification/check-acyclic-lowering.ts';
export function processControls(){
 const base='build/linear-width',receipt=`${base}/fresh-receipt.json`,saved=fs.readFileSync(receipt),rows=[];
 const python=process.env.PYTHON??'python3';
 const located=spawnSync(python,['-c','import sys; print(sys.executable)'],{encoding:'utf8'});assert.equal(located.status,0);
 const wrapper=path.resolve(`${base}/failure-python`);
 fs.writeFileSync(wrapper,`#!${located.stdout.trim()}\nimport os,sys\nargs=sys.argv[1:]\nif 'verification/linear_width_product.py' in args:\n mode=os.environ['LINEAR_FAILURE_MODE']\n if mode=='empty':sys.exit(0)\n if mode=='exit':print('injected linear child exit');sys.exit(42)\n if mode=='optimized':args=['-O']+args\nos.execv(sys.executable,[sys.executable]+args)\n`,{mode:0o755});
 for(const [name,env,reason] of [
  ['missing-python',{PYTHON:'/no-such-linear-python'},'/no-such-linear-python'],
  ['empty-report',{PYTHON:wrapper,LINEAR_FAILURE_MODE:'empty'},'missing fresh child report'],
  ['failed-child',{PYTHON:wrapper,LINEAR_FAILURE_MODE:'exit'},'injected linear child exit'],
  ['optimized-child',{PYTHON:wrapper,LINEAR_FAILURE_MODE:'optimized'},'assertions required'],
 ] as const){
  fs.writeFileSync(receipt,saved);const old=new Set(fs.readdirSync(`${base}/runs`));
  const result=spawnSync(process.execPath,['verification/check-linear-width.ts'],{env:{...process.env,...env},encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
  const log=`${base}/${name}.log`;fs.writeFileSync(log,(result.stdout??'')+(result.stderr??''));
  assert.ifError(result.error);assert.equal(result.signal,null);assert.notEqual(result.status,0);assert.equal(fs.existsSync(receipt),false);
  const added=fs.readdirSync(`${base}/runs`).filter(n=>!old.has(n));assert.equal(added.length,1);
  const run=`${base}/runs/${added[0]}`,retired=`${run}/previous.json`;assert.deepEqual(fs.readFileSync(retired),saved);
  const logs=fs.readdirSync(run).filter(n=>n.endsWith('.log')).map(n=>`${run}/${n}`);
  assert.ok((fs.readFileSync(log,'utf8')+logs.map(p=>fs.readFileSync(p,'utf8')).join('\n')).includes(reason),name+' wrong reason');
  rows.push({name,exitCode:result.status,retired,retiredSha256:digest(saved),log,logSha256:digest(fs.readFileSync(log)),logs:logs.map(p=>({artifact:p,sha256:digest(fs.readFileSync(p))}))});
 }
 return rows;
}
