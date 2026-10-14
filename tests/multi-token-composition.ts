import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const python = process.env.PYTHON ?? 'python3';
const directory = path.resolve(process.env.TOKEN_COMPOSITION_OUTPUT ?? 'build/multi-token-composition');
const sources = 'verification/multi_token_composition';
const output = 'build/multi-token-composition-test.json';
fs.mkdirSync(directory, {recursive: true});
if (fs.existsSync(output)) {
  fs.copyFileSync(output, path.join(directory, `retired-test-${crypto.randomUUID()}.json`));
  fs.rmSync(output);
}
function run(command: string, args: string[], log?: string) {
  const result = spawnSync(command, args, {encoding: 'utf8', env: process.env});
  if (log) fs.writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? ''));
  assert(!result.error, String(result.error));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim().split('\n').at(-1)!;
}
run(process.execPath, ['verification/check-multi-token-composition.ts']);
const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'fresh-receipt.json'), 'utf8'));
const prior = fs.readFileSync(path.join(directory, 'fresh-receipt.json'));
const attempts = new Set(fs.readdirSync(directory, {withFileTypes: true}).filter(entry => entry.isDirectory() && entry.name.startsWith('wrapper-')).map(entry => entry.name));
const missing = path.join(directory, `absent-python-${crypto.randomUUID()}`);
const rejected = spawnSync(process.execPath, ['verification/check-multi-token-composition.ts'], {
  encoding: 'utf8', env: {...process.env, PYTHON: missing},
});
fs.writeFileSync(path.join(directory, 'wrapper-process.log'), (rejected.stdout ?? '') + (rejected.stderr ?? ''));
assert(!rejected.error, String(rejected.error));
assert.notEqual(rejected.status, 0);
assert(!fs.existsSync(path.join(directory, 'fresh-receipt.json')));
const added = fs.readdirSync(directory, {withFileTypes: true}).filter(entry => entry.isDirectory() && entry.name.startsWith('wrapper-') && !attempts.has(entry.name)).map(entry => entry.name);
assert.equal(added.length, 1);
const failedAttempt = path.join(directory, added[0]);
assert.deepEqual(fs.readFileSync(path.join(failedAttempt, 'retired-receipt.json')), prior);
const failure = JSON.parse(fs.readFileSync(path.join(failedAttempt, 'failure.json'), 'utf8'));
assert.equal(failure.passed, false);
assert.match(failure.error, /ENOENT/);
const inputs = run(python, ['-B', `${sources}/input-controls.py`, receipt.run], path.join(directory, 'input-controls.log'));
assert.equal(JSON.parse(fs.readFileSync(inputs, 'utf8')).passed, true);
const reports = run(python, ['-B', `${sources}/report-controls.py`, receipt.run], path.join(directory, 'report-controls.log'));
const processes = run(python, ['-B', `${sources}/process-controls.py`, receipt.run], path.join(directory, 'process-controls.log'));
assert.equal(JSON.parse(fs.readFileSync(reports, 'utf8')).passed, true);
assert.equal(JSON.parse(fs.readFileSync(processes, 'utf8')).passed, true);
// A new complete run must restore success after the negative process probes.
run(process.execPath, ['verification/check-multi-token-composition.ts']);
run(python, ['-B', `${sources}/audit.py`, path.join(directory, 'fresh-receipt.json'), reports, processes, inputs, 'build/multi-token-composition-test.json']);
const evidence = JSON.parse(fs.readFileSync(output, 'utf8'));
evidence.wrapperProcessControl = {
  name: 'missing-python-before-controller', passed: true, failedAttempt,
  retiredSha256: crypto.createHash('sha256').update(prior).digest('hex'),
  logSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, 'wrapper-process.log'))).digest('hex'),
};
fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
console.log('Multi-account token composition: symbolic, native, report and process checks passed');
