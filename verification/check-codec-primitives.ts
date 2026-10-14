import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { prepareBend } from '../scripts/build.ts';

fs.rmSync('build/codec-primitives-refinement.json',{force:true});
prepareBend();
const { Backend, checkedBook } = await import('../compiler/backend.ts');
const { emitCodecs } = await import('../compiler/codecs.ts');
const schema = new Backend(await checkedBook('tests/iteration.bend')).emit(['count','toggle']).schema;
const primitives = schema.types.filter(t => t.kind !== 'adt');
assert.deepEqual(primitives.map(t => [t.name,t.kind,t.max]),
  [['U32','u32',undefined],['Bool','bool',undefined],['Nat','u32',64]]);
const actual = emitCodecs({...schema, types:primitives, exports:[]});
// This exact-body audit ties the bitvector model to the current generated C
// primitive templates. Any change requires a fresh review of C semantics.
const expected = `/* Generated canonical wire codecs. Include the generated types first. */
#pragma once
#define bend_U32_WIRE_SIZE 4u
static inline int bend_U32_decode(const unsigned char *p, unsigned long long n, bend_u32 *out) {
  if (n != 4u) return 0;
  *out = (bend_u32)p[0] | ((bend_u32)p[1] << 8) | ((bend_u32)p[2] << 16) | ((bend_u32)p[3] << 24);
  return 1;
}
static inline int bend_U32_encode(unsigned char *p, unsigned long long n, const bend_u32 *value) {
  if (n != 4u) return 0;
  for (unsigned i = 0; i < 4; ++i) p[i] = (unsigned char)(*value >> (8 * i));
  return 1;
}
#define bend_Bool_WIRE_SIZE 1u
static inline int bend_Bool_decode(const unsigned char *p, unsigned long long n, bend_u32 *out) {
  if (n != 1u) return 0;
  if (p[0] > 1) return 0;
  *out = p[0];
  return 1;
}
static inline int bend_Bool_encode(unsigned char *p, unsigned long long n, const bend_u32 *value) {
  if (n != 1u) return 0;
  if (*value > 1) return 0;
  p[0] = (unsigned char)*value;
  return 1;
}
#define bend_Nat_WIRE_SIZE 4u
static inline int bend_Nat_decode(const unsigned char *p, unsigned long long n, bend_u32 *out) {
  if (n != 4u) return 0;
  *out = (bend_u32)p[0] | ((bend_u32)p[1] << 8) | ((bend_u32)p[2] << 16) | ((bend_u32)p[3] << 24);
  if (*out > 64u) return 0;
  return 1;
}
static inline int bend_Nat_encode(unsigned char *p, unsigned long long n, const bend_u32 *value) {
  if (n != 4u) return 0;
  if (*value > 64u) return 0;
  for (unsigned i = 0; i < 4; ++i) p[i] = (unsigned char)(*value >> (8 * i));
  return 1;
}
`;
assert.equal(actual, expected, 'Generated primitive C codec changed from the reviewed template');
const bad=actual.replace('((bend_u32)p[3] << 24)', '((bend_u32)p[2] << 24)');
assert.notEqual(bad,actual,'Missing codec mutation target');
assert.notEqual(bad,expected,'Wrong-high-byte codec mutation escaped exact audit');
fs.mkdirSync('build',{recursive:true});
fs.writeFileSync('build/codec-primitives.wire.h',actual);
const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/codec_primitives.py'],{encoding:'utf8'});
assert.ifError(result.error);
assert.equal(result.status,0,result.stderr||result.stdout);
const path='build/codec-primitives-refinement.json';
const report=JSON.parse(fs.readFileSync(path,'utf8'));
assert.equal(report.claims.filter((c:any)=>c.result==='unsat').length,5);
assert.equal(report.claims.filter((c:any)=>c.result==='sat').length,3);
const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
report.inputs={...report.inputs,...Object.fromEntries([
  'compiler/codecs.ts','compiler/schema.ts','compiler/backend.ts', 'compiler/tagged-sum-ir.ts',
  'tests/iteration.bend','verification/check-codec-primitives.ts',
].map(file=>[file,hash(file)]))};
report.sourceMutation='wrong high byte rejected by exact emitted-C audit';
fs.writeFileSync(path,JSON.stringify(report,null,2)+'\n');
process.stdout.write(result.stdout);
