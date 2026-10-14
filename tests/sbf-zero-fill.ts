import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const child=spawnSync(process.env.PYTHON??'python3',['-B','tests/sbf-zero-fill.py'],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,child.stderr);
const result=JSON.parse(child.stdout);assert.equal(result.passed,true);assert.equal(result.claims,6);assert.equal(result.interpreterCases,769);assert.equal(result.controls,6);assert.equal(result.reportRefusals,16);
console.log(child.stdout.trim());
