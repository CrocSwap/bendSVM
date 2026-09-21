import fs from 'node:fs';
import { prepareBend, run } from './build.ts';

fs.mkdirSync('build', { recursive: true });
prepareBend();
await (await import('../tests/iteration.ts')).testIteration();
await import('../verification/check-iteration.ts');
run('cargo', ['test', '--locked', '--test', 'sbf', 'bounded_iteration', '--', '--nocapture']);
