import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Backend, checkedBook } from '../compiler/backend.ts';

export async function testNativeArithmeticGuard() {
  const book = await checkedBook('sdk/math.bend');
  const roots = ['divmod','mul32'];
  const native = new Backend(book).emit(roots).c;
  const limbs = new Backend(book,{nativeArithmetic:false}).emit(roots).c;
  assert.match(native,/unsigned long long q = n \/ d;/);
  assert.match(native,/unsigned long long product = \(unsigned long long\)a0 \* \(unsigned long long\)a1;/);
  assert.doesNotMatch(limbs,/unsigned long long q = n \/ d;/);
  assert.doesNotMatch(limbs,/unsigned long long product = \(unsigned long long\)a0 \*/);

  const source = fs.readFileSync('sdk/math.bend','utf8');
  const directory = fs.mkdtempSync(path.resolve('build/native-arithmetic-guard-'));
  try {
    // A semantic change to the checked SDK must use the source-defined path.
    const altered = source.replace('DivErr{3}','DivErr{4}');
    assert.notEqual(altered,source);
    const file = path.join(directory,'math.bend');
    fs.writeFileSync(file,altered);
    const changed = new Backend(await checkedBook(file)).emit(roots).c;
    assert.doesNotMatch(changed,/unsigned long long q = n \/ d;/);
    assert.doesNotMatch(changed,/unsigned long long product = \(unsigned long long\)a0 \*/);
    assert.match(changed,/DivErr_make\(4u\)/);
  } finally {
    fs.rmSync(directory,{recursive:true,force:true});
  }
  console.log('Native arithmetic source guard passed; changed SDK semantics fell back to Bend lowering');
}

if (import.meta.main) await testNativeArithmeticGuard();
