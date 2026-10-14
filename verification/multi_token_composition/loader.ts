import assert from 'node:assert/strict';
import {main} from '../check-loader.ts';
assert.equal(process.argv.length, 3, 'usage: loader.ts OUTPUT_DIRECTORY');
await main(process.argv[2]);
