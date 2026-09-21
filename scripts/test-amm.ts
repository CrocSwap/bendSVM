import fs from 'node:fs';
import { prepareBend, run } from './build.ts';
fs.mkdirSync('build', { recursive: true });
prepareBend();
await (await import('../tests/amm.ts')).testAmm();
run('cargo', ['test', '--locked', '--test', 'sbf', 'amm_sbf', '--', '--nocapture']);
