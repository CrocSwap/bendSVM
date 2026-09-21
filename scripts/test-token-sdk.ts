import fs from 'node:fs';
import { prepareBend, run } from './build.ts';

fs.mkdirSync('build', { recursive: true });
prepareBend();
await (await import('../tests/token-three.ts')).testTokenThree();
await (await import('../tests/token-issuance.ts')).testTokenIssuance();
for (const module of ['token_three_sbf', 'token_issuance_sbf'])
  run('cargo', ['test', '--locked', '--test', 'sbf', module, '--', '--nocapture']);
