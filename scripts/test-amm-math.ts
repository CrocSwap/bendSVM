import fs from 'node:fs';
import { prepareBend, run } from './build.ts';

fs.mkdirSync('build', { recursive: true });
prepareBend();
await (await import('../tests/amm-pricing.ts')).testAmmPricing();
await (await import('../tests/sqrt.ts')).testSqrt();
run('cargo', ['test', '--locked', '--test', 'sbf', 'amm', '--', '--nocapture']);
