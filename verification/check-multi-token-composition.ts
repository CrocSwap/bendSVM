import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const python = process.env.PYTHON ?? 'python3';
const directory = path.resolve(process.env.TOKEN_COMPOSITION_OUTPUT ?? 'build/multi-token-composition');
const attempt = path.join(directory, `wrapper-${crypto.randomUUID()}`);
fs.mkdirSync(attempt, {recursive: true});
const receiptPath = path.join(directory, 'fresh-receipt.json');
if (fs.existsSync(receiptPath)) {
  fs.copyFileSync(receiptPath, path.join(attempt, 'retired-receipt.json'));
  fs.rmSync(receiptPath);
}
fs.rmSync(path.join(directory, 'fresh-receipt.pending.json'), {force: true});
try {
  const result = spawnSync(python, ['-B', 'verification/multi_token_composition/controller.py'], {
    stdio: 'inherit', env: process.env,
  });
  assert(!result.error, String(result.error));
  assert.equal(result.status, 0, 'Multi-account token composition qualification failed');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.passed, true);
  console.log('Fresh conditional multi-account token composition qualification passed');
} catch (error) {
  fs.rmSync(receiptPath, {force: true});
  fs.writeFileSync(path.join(attempt, 'failure.json'), JSON.stringify({passed: false, error: String(error)}, null, 2) + '\n');
  throw error;
}
