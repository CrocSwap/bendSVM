import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Backend, checkedBook } from '../compiler/backend.ts';
import { checkedMathSourceSha256 } from '../compiler/native-arithmetic.ts';
import { BEND_COMMIT, prepareBend } from '../scripts/build.ts';

prepareBend();
const hash = (file:string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const source = 'sdk/math.bend';
const book = await checkedBook(source);
const c = new Backend(book).emit(['divmod','mul32']).c;
// Exact structural connection from the bitvector formulas to emitted C.
// Formatting or semantic changes require a deliberate review of this audit.
function functionBody(name:string):string {
  const signature = `${name}(`;
  assert.equal(c.split(signature).length,2,`expected one ${name}`);
  const middle=c.indexOf(signature),start=c.lastIndexOf('static',middle),end=c.indexOf('\n}',middle)+2;
  assert(start>=0 && end>middle);
  return c.slice(start,end);
}
assert.equal(functionBody('bend_divmod'),`static __attribute__((noinline)) bend_DivResult_t bend_divmod(bend_U64_t a0, bend_U64_t a1) {
  (void)a0;
  (void)a1;
  _Static_assert(sizeof(unsigned long long) == 8, "Requires 64-bit unsigned long long");
  if (a0.tag != 0u || a1.tag != 0u) __builtin_unreachable();
  unsigned long long n = ((unsigned long long)a0.as.c0.f1 << 32) | a0.as.c0.f0;
  unsigned long long d = ((unsigned long long)a1.as.c0.f1 << 32) | a1.as.c0.f0;
  if (!d) return bend_DivErr_make(3u);
  unsigned long long q = n / d;
  unsigned long long r = n % d;
  return bend_DivOk_make(bend_Division_make(
    bend_U64_make((bend_u32)q, (bend_u32)(q >> 32)),
    bend_U64_make((bend_u32)r, (bend_u32)(r >> 32))));
}`);
assert.equal(functionBody('bend_mul32'),`static __attribute__((noinline)) bend_U64_t bend_mul32(bend_u32 a0, bend_u32 a1) {
  (void)a0;
  (void)a1;
  _Static_assert(sizeof(unsigned long long) == 8, "Requires 64-bit unsigned long long");
  unsigned long long product = (unsigned long long)a0 * (unsigned long long)a1;
  return bend_U64_make((bend_u32)product, (bend_u32)(product >> 32));
}`);
for (const file of ['build/division-refinement.json','build/multiplication-refinement.json'])
  assert(fs.existsSync(file),`run verify:division and verify:multiplication first: ${file}`);
const division = JSON.parse(fs.readFileSync('build/division-refinement.json','utf8'));
const multiplication = JSON.parse(fs.readFileSync('build/multiplication-refinement.json','utf8'));
for (const report of [division,multiplication]) {
  assert.equal(report.bendCommit,BEND_COMMIT);
  for (const [file,digest] of Object.entries(report.hashes))
    assert.equal(hash(file),digest,`stale source proof: ${file}`);
}
assert(division.positive.wrappers.every((c:{result:string})=>c.result==='unsat'));
assert(multiplication.positive.claims.every((c:{result:string})=>c.result==='unsat'));
const result = spawnSync(process.env.PYTHON??'python3',
  ['-B','verification/native_arithmetic.py'],{encoding:'utf8'});
assert.equal(result.status,0,result.stderr||result.stdout);
const proof=JSON.parse(result.stdout);
assert(proof.claims.every((c:{result:string})=>c.result==='unsat'));
assert.equal(proof.negative.result,'sat');
const files=[source,'compiler/backend.ts', 'compiler/tagged-sum-ir.ts','compiler/native-arithmetic.ts',
  'verification/model.ts','verification/native_arithmetic.py',
  'verification/check-native-arithmetic.ts'];
fs.writeFileSync('build/native-arithmetic-refinement.json',JSON.stringify({
  bendCommit:BEND_COMMIT,checkedMathSourceSha256,proof,
  sourceProofs:{division:hash('build/division-refinement.json'),
    multiplication:hash('build/multiplication-refinement.json')},
  hashes:Object.fromEntries(files.map(file=>[file,hash(file)])),
},null,2)+'\n');
console.log('Native arithmetic bridge passed: checked source proofs, C template audit, and bitvector pack/split obligations');
