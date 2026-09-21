import fs from 'node:fs';
import { prepareBend, run } from './build.ts';

fs.mkdirSync('build', {recursive:true});
prepareBend();
await (await import('../tests/diagnostics.ts')).testDiagnostics();
run(process.env.CC??'clang',['-std=c17','-O1','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',
  '-fno-sanitize-recover=all','-Iruntime','tests/collection-runtime.c','-o','build/collection-runtime']);
run('build/collection-runtime',[]);
await (await import('../tests/collection.ts')).testCollection();
await (await import('../tests/collection-store.ts')).testCollectionStore();
run('cargo', ['test','--locked','--test','sbf','collection_','--','--nocapture']);
