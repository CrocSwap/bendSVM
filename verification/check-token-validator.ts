import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const output = 'build/token-validator-refinement.json';
fs.rmSync(output, {force:true});
fs.rmSync(output + '.pending', {force:true});
try {
  const result = spawnSync(process.env.PYTHON ?? 'python3', ['-B', 'verification/token_validate.py'],
    {encoding:'utf8', timeout:300_000, maxBuffer:1 << 24});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.passed, true);
  assert.equal(report.z3, '5.1.0');
  assert.deepEqual(report.claims.map((claim:any) => [claim.name, claim.result]), [
    ['account and data read bounds', 'unsat'],
    ['exact error/success contract', 'unsat'],
    ['complete return coverage', 'unsat'],
  ]);
  assert(report.readObligations > 0);
  assert(report.readObligationsByKind['account index within caller count'] > 0);
  assert(report.readObligationsByKind.read_le > 0);
  assert(report.readObligationsByKind.equal_key > 0);
  assert.deepEqual(report.readLeLengths, [4, 8]);
  assert(report.helperCallSites.read_le > 0 && report.helperCallSites.equal_key > 0);
  assert.equal(report.loopObligations, 0);
  assert.equal(report.witnesses.length, 19);
  assert(report.witnesses.every((witness:any) => witness.counterexample?.smtModel));
  for (const name of ['mint data byte before size guard', 'read_le before token size guard',
    'equal_key 32-byte data span exceeds account size']) {
    const mutation = report.mutations.find((item:any) => item.name === name);
    assert(mutation && mutation.kind === 'semantic');
    assert(mutation.counterexample.violated.includes('account and data read bounds'));
    if (name !== 'equal_key 32-byte data span exceeds account size')
      assert.deepEqual(mutation.counterexample.violated, ['account and data read bounds']);
  }
  assert.equal(report.mutations.length, 60);
  assert.equal(report.mutations.filter((mutation:any) => mutation.kind === 'semantic' && mutation.counterexample?.smtModel).length, 34);
  assert.equal(report.mutations.filter((mutation:any) => mutation.kind === 'grammar' && mutation.reason).length, 26);
  assert.equal(report.equivalents.length, 5);
  assert(report.equivalents.every((variant:any) => variant.result === 'unsat'));
  for (const [file, digest] of Object.entries(report.inputs)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), digest, file);
  }
  process.stdout.write(result.stdout);
} catch (error) {
  fs.rmSync(output, {force:true});
  fs.rmSync(output + '.pending', {force:true});
  throw error;
}
