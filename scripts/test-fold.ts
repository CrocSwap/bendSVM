import fs from 'node:fs';
import { prepareBend, run } from './build.ts';

fs.mkdirSync('build', { recursive: true });
prepareBend();
await (await import('../tests/fold.ts')).testFold();
await import('../verification/check-fold.ts');
run('cargo', ['test', '--locked', '--test', 'sbf', 'bounded_folds_execute_in_sbf', '--', '--nocapture']);
