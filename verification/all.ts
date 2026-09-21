import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const checks=[
  ['queue','check-queue.ts','queue-refinement.json'],
  ['collection','check-collection.ts','collection-refinement.json'],
  ['batch','check-batch.ts','batch-refinement.json'],
  ['fold','check-fold.ts','fold-refinement.json'],
  ['iteration','check-iteration.ts','iteration-refinement.json'],
  ['buffer','check-buffer.ts','buffer-refinement.json'],
  ['arithmetic','check.ts','math-refinement.json'],
  ['division','check-division.ts','division-refinement.json'],
  ['multiplication','check-multiplication.ts','multiplication-refinement.json'],
  ['wide','check-wide.ts','wide-refinement.json'],
  ['sqrt','check-sqrt.ts','sqrt-refinement.json'],
  ['amm-pricing','check-amm-pricing.ts','amm-pricing-refinement.json'],
  ['amm','check-amm.ts','amm-refinement.json'],
  ['vault','check-vault.ts','vault-refinement.json'],
  ['vesting-payout','check-vesting.ts','vesting-refinement.json'],
  ['vesting-process','check-vesting-process.ts','vesting-process.json'],
  ['exchange','check-exchange.ts','exchange-refinement.json'],
];
fs.mkdirSync('build',{recursive:true});
const results=[];
for(const [name,script,artifact] of checks) {
  console.log(`Checking ${name}`);
  const result=spawnSync(process.execPath,[`verification/${script}`],{stdio:'inherit'});
  assert.equal(result.status,0,`${name} refinement failed`);
  const file=`build/${artifact}`;
  results.push({name,artifact:file,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
}
fs.writeFileSync('build/refinement-suite.json',JSON.stringify({passed:true,checks:results},null,2)+'\n');
console.log(`All ${checks.length} source refinement commands passed`);
