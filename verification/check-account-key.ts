import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.env.PYTHON ?? 'python3', ['-B', 'verification/account_key.py'],
  { encoding: 'utf8' });
assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr || result.stdout);
process.stdout.write(result.stdout);
