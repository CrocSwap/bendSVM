import fs from 'node:fs';
import { prepareBend, run } from './build.ts';

fs.mkdirSync('build', { recursive: true });
prepareBend();
await (await import('../tests/generics.ts')).testGenerics();
run('cargo', ['test', '--locked', '--test', 'sbf', 'generic_specializations_execute_in_sbf', '--', '--nocapture']);
