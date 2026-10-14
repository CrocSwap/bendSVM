import {testZipFold} from '../tests/zip-fold.ts';
import {run} from './build.ts';

await testZipFold();
run('cargo',['test','--locked','--test','sbf','zip_fold_order_executes_in_sbf','--','--nocapture']);
