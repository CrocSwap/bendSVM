import {run} from './build.ts';
await (await import('../tests/queue.ts')).testQueue();
run('cargo',['test','--locked','--test','sbf','queue_','--','--nocapture']);
