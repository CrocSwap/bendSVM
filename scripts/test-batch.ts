import fs from 'node:fs';
import { prepareBend, run } from './build.ts';

fs.mkdirSync('build', { recursive: true });
prepareBend();
await (await import('../tests/batch.ts')).testBatch();
run('cargo', ['test', '--locked', '--test', 'sbf', 'batch_', '--', '--nocapture']);
