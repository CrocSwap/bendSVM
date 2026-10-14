import {testTreeFold} from '../tests/tree-fold.ts';
import {testTreeFoldControls} from '../tests/tree-fold-controls.ts';
import {run} from './build.ts';

await testTreeFold();
await testTreeFoldControls();
run('cargo',['test','--locked','--test','sbf','tree_folds_','--','--nocapture']);
