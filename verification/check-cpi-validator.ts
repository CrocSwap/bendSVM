import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const output = 'build/cpi-validator-refinement.json';
fs.rmSync(output, {force:true});
const result = spawnSync(process.env.PYTHON ?? 'python3', ['-B', 'verification/cpi_validate.py'],
  {encoding:'utf8', timeout:180_000, maxBuffer:1 << 22});
assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr || result.stdout);
const report = JSON.parse(fs.readFileSync(output, 'utf8'));
assert.equal(report.passed, true);
assert.equal(report.z3, '5.1.0');
assert.deepEqual(report.claims.map((c:any) => [c.name,c.result]), [
  ['read bounds and loop termination','unsat'], ['exact error/success contract','unsat'], ['complete return coverage','unsat'],
]);
assert(report.readObligations > 0 && report.loopObligations > 0);
assert.equal(report.witnesses.length, 5);
assert(report.witnesses.every((w:any) => w.counterexample));
assert.equal(report.mutations.length, 43);
assert.equal(report.mutations.filter((m:any) => m.kind === 'semantic' && m.counterexample).length, 29);
assert.equal(report.mutations.filter((m:any) => m.kind === 'grammar' && m.reason).length, 14);
assert.equal(report.equivalents.length, 6);
assert(report.equivalents.every((e:any) => e.result === 'unsat'));
for (const [file, hash] of Object.entries(report.inputs)) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash, file);
}
process.stdout.write(result.stdout);
