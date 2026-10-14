import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as B from '../.deps/bend/bend2/bend.ts';
import { Backend, checkedProgram } from '../compiler/backend.ts';
import { referenceCache } from './bend-reference-cache.ts';
import { writeArtifacts } from '../compiler/artifacts.ts';
import { wireCodec, type WireValue } from '../sdk/wire.ts';
import { compileSbf, run } from '../scripts/build.ts';

export type PureCase = {name: string; args: WireValue[]; expected: WireValue};
export async function testPure(file: string, roots: string[], stem: string,
    makeCases: (schema: ReturnType<Backend['emit']>['schema']) => PureCase[]) {
  const checked = await checkedProgram(file), book = checked.book, emitted = new Backend(book).emit(roots);
  writeArtifacts(stem,emitted);
  const types = new Map(emitted.schema.types.map(t => [t.name,t]));
  const codec = wireCodec(emitted.schema);
  function term(type: string, value: WireValue): B.HTerm {
    const t = types.get(type)!;
    if(type==='Nat') {
      let term:B.HTerm=B.Ctr('Zero',[]);
      for(let i=0;i<(value as number);i++)term=B.Ctr('Succ',[term]);
      return term;
    }
    if (t.kind === 'u32') return B.term_higher(B.u32_to_term(value as number));
    if (t.kind === 'bool') return B.Ctr(value ? 'True':'False',[]);
    assert.equal(typeof value,'object');
    const v = value as {constructor: string,fields:Record<string,WireValue>};
    const variant = t.variants.find(c => c.name === v.constructor)!;
    return B.Ctr(variant.sourceName ?? variant.name,variant.fields.map(f => term(f.type,v.fields[f.name])));
  }
  function value(type: string, term: B.HTerm): WireValue {
    const t = types.get(type)!;
    if(type==='Nat') {
      let n=0;while(term.$==='Ctr'&&term.k==='Succ'){n++;term=term.x[0];}
      assert(term.$==='Ctr'&&term.k==='Zero');return n;
    }
    if (t.kind === 'u32') { const n = B.u32_from_term(term); assert.notEqual(n,null); return n!; }
    assert.equal(term.$,'Ctr'); if (term.$ !== 'Ctr') throw new Error('Expected constructor');
    if (t.kind === 'bool') return term.k === 'True';
    const variant = t.variants.find(v => (v.sourceName ?? v.name) === term.k)!;
    return {constructor:variant.name,fields:Object.fromEntries(variant.fields.map((f,i) => [f.name,value(f.type,term.x[i])]))};
  }
  const cases = makeCases(emitted.schema), vectors = [];
  const cache = referenceCache(checked.files, emitted.schema);
  for (const [index,c] of cases.entries()) {
    if (index % 32 === 0) console.log(`${stem}: Bend reference ${index+1}/${cases.length}`);
    const exp = emitted.schema.exports.find(e => e.name === c.name)!;
    let call: B.HTerm = B.Ref(c.name);
    c.args.forEach((a,i) => { call = B.App(call,term(exp.args[i],a)); });
    const expected = codec.encode(exp.result,c.expected);
    const reference = cache.result({name:c.name,args:c.args},
      () => Uint8Array.from(codec.encode(exp.result,value(exp.result,B.term_snf(book,call)))));
    assert.deepEqual([...reference],[...expected],`${c.name} case ${index}`);
    vectors.push({name:`${c.name}-${index}`,input:[...codec.call(c.name,c.args)],expected:[...expected]});
  }
  const name = stem.split('/').at(-1)!;
  fs.writeFileSync(stem+'-native.c',`#include <stdio.h>
#include "${name}.dispatch.h"
int main(void) {
  unsigned n, v; unsigned char input[1024], output[1024];
  while (scanf("%u",&n)==1) {
    if (n>1024) return 1;
    for (unsigned i=0;i<n;++i) { if(scanf("%u",&v)!=1 || v>255) return 2; input[i]=v; }
    unsigned long long written=0;
    if(!bend_wire_dispatch(input,n,output,1024,&written)) return 3;
    for(unsigned i=0;i<written;++i) printf(i ? " %u":"%u",output[i]);
    puts("");
  }
  return 0;
}
`);
  run(process.env.CC ?? 'clang',['-std=c17','-O1','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',
    '-fno-sanitize-recover=all',stem+'-native.c','-o',stem+'-native']);
  const native = spawnSync(stem+'-native',[],{encoding:'utf8',input:vectors.map(v => `${v.input.length} ${v.input.join(' ')}`).join('\n')+'\n'});
  assert.equal(native.status,0,native.stderr);
  assert.deepEqual(native.stdout.trim().split('\n'),vectors.map(v => v.expected.join(' ')));
  fs.writeFileSync(stem+'-sbf.c',`#include "solana_min.h"\n#include "${name}.dispatch.h"\n#include "invoke.h"\n`);
  compileSbf(stem+'-sbf.c',stem);
  fs.writeFileSync(stem+'-vectors.json',JSON.stringify(vectors)+'\n');
  fs.writeFileSync(stem+'-reference-cache.json',JSON.stringify(cache.stats,null,2)+'\n');
  console.log(`${vectors.length} ${name} oracle/Bend/native cases passed (Bend reference: ${cache.stats.evaluated} evaluated, ${cache.stats.hits} cached, mode ${cache.stats.mode}); SBF built`);
}
