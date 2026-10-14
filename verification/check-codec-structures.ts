import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {prepareBend} from '../scripts/build.ts';

const reportPath = 'build/codec-structures-refinement.json';
const pendingPath = reportPath + '.pending';
fs.rmSync(pendingPath, {force:true});
fs.rmSync(reportPath, {force:true});
prepareBend();
// Discharge the primitive base cases in this invocation, not via a stale report.
const base = spawnSync(process.execPath, ['verification/check-codec-primitives.ts'], {stdio:'inherit'});
assert.ifError(base.error); assert.equal(base.status, 0, 'Primitive codec prerequisite failed');
const {Backend, checkedProgram} = await import('../compiler/backend.ts');
const {writeArtifacts} = await import('../compiler/artifacts.ts');
const directory = 'build/codec-structures';
fs.mkdirSync(directory, {recursive:true});
const boundary = `${directory}/boundary.bend`;
fs.writeFileSync(boundary, `import Base\ntype Enum is Data:\n${Array.from({length:256},(_,i)=>`  Tag${i}{}`).join('\n')}
type Wide is Data:\n  Wide{${[...Array.from({length:255},(_,i)=>`w${i}: U32`),'b0: Bool','b1: Bool','b2: Bool'].join(', ')}}
def enum_identity(value: Enum) -> Enum:\n  value
def wide_value() -> Wide:\n  Wide{${[...Array(255).fill('0'),'False{}','False{}','False{}'].join(', ')}}\n`);
// Exercise both sides of the decoder outlining threshold independently of
// the emitter's threshold constant: 1 tag + 63 words + 2/3 booleans.
for (const bytes of [255, 256]) {
  const fields = [...Array.from({length:63}, (_,i)=>`w${i}: U32`),
    ...Array.from({length:bytes-253}, (_,i)=>`b${i}: Bool`)];
  fs.appendFileSync(boundary, `type Edge${bytes} is Data:\n  Edge${bytes}{${fields.join(', ')}}\ndef edge${bytes}(value: Edge${bytes}) -> Edge${bytes}:\n  value\n`);
}
const selections: [string,string,string[]][] = [
  ['packets','tests/codecs.bend',['identity','flip']],
  ['nested','tests/codec-structures.bend',['identity']],
  ['generics','tests/generics.bend',['word','flag','nested','unwrap','choose_word','choose_flag']],
  ['collection','tests/collection-record.bend',['process','select']],
  ['vault','examples/vault/PROOF.bend',['vault.process']],
  ['vesting','examples/vesting/PROOF.bend',['vesting.process']],
  ['exchange','examples/exchange/PROOF.bend',['exchange.process']],
  ['amm','examples/amm/PROOF.bend',['amm.process']],
  ['batch','examples/batch/PROOF.bend',['batch.process']],
  ['queue','examples/queue/PROOF.bend',['queue.process','queue.select']],
  ['boundary',boundary,['enum_identity','wide_value','edge255','edge256']],
];
const inputs: string[] = [];
const fixtures = [];
for (const [name, source, roots] of selections) {
  const checked = await checkedProgram(source);
  inputs.push(...checked.files);
  const emitted = new Backend(checked.book).emit(roots);
  const stem = `${directory}/${name}`;
  writeArtifacts(stem, emitted);
  // The validator consumes the written artifacts, including their include
  // context, rather than a second in-memory emission.
  fixtures.push({name, headerName:`${name}.h`, schema:JSON.parse(fs.readFileSync(stem+'.schema.json','utf8')),
    native:fs.readFileSync(stem+'.h','utf8'), codecs:fs.readFileSync(stem+'.wire.h','utf8')});
  inputs.push(source, stem+'.schema.json', stem+'.h', stem+'.wire.h');
}
const mutations: any[] = [];
function mutate(name:string, fixture:string, part:'native'|'codecs', from:string, to:string, expected:string) {
  const item = structuredClone(fixtures.find(f=>f.name===fixture)!);
  assert(item[part].includes(from), `Missing mutation target: ${name}`);
  item[part] = item[part].replace(from,to);
  mutations.push({...item,name,expected});
}
mutate('read-offset','packets','codecs','p + 5, 4, &f1','p + 4, 4, &f1','child address relation: sat');
mutate('write-offset','packets','codecs','p + 5, 4, &value->as.c0.f1','p + 4, 4, &value->as.c0.f1','child address relation: sat');
mutate('wire-tag','packets','codecs','case 3:\n    p[0] = 3;','case 3:\n    p[0] = 2;','canonical byte assembly: sat');
mutate('maker-order','packets','codecs','bend_Point_make(f0, f1)','bend_Point_make(f1, f0)','decoder constructor mapping');
mutate('field-projection','packets','codecs','&value->as.c0.f1','&value->as.c0.f0','writer field projection');
mutate('child-width','packets','codecs','p + 5, 4, &f1','p + 5, 3, &f1','decoder child width');
mutate('padding-omitted','packets','codecs','    for (unsigned i = 1; i < 11; ++i) if (p[i] != 0) return 0;\n','','canonical decoder padding range');
mutate('zero-region-short','packets','codecs','i < 11; ++i) p[i] = 0','i < 10; ++i) p[i] = 0','public encoder must clear');
mutate('size-macro','packets','codecs','bend_Point_WIRE_SIZE 9u','bend_Point_WIRE_SIZE 8u','exact codec size guards');
mutate('size-guard','packets','codecs','if (n != 9u)','if (n != 8u)','exact codec size guards');
mutate('ignored-decode-failure','packets','codecs','if (!bend_U32_decode(p + 1, 4, &f0)) return 0;','if (!bend_U32_decode(p + 1, 4, &f0)) return 1;','unexpected C');
mutate('default-success','packets','codecs','default: return 0;','default: return 1;','unexpected C');
mutate('native-maker-order','packets','native','.f0 = a0, .f1 = a1','.f0 = a1, .f1 = a0','native maker');
mutate('native-field-type','packets','native','bend_u32 f0; bend_u32 f1;','bend_u32 f0; unsigned char f1;','native field layout');
mutate('inserted-function','packets','codecs','\n#pragma once','\n#pragma once\nstatic int extra(void){return 1;}','unexpected C');
mutate('macro-injection','packets','native','#pragma once','#pragma once\n#define f0 f1','unsupported or non-line-isolated directive');
mutate('octal-offset','packets','codecs','p + 5, 4, &f1','p + 05, 4, &f1','canonical decimal');
mutate('large-decoder-outline-omitted','boundary','codecs',
  'static __attribute__((noinline)) inline int bend_Edge256_decode',
  'static inline int bend_Edge256_decode','unexpected C');
mutate('small-decoder-outline-added','boundary','codecs',
  'static inline int bend_Edge255_decode',
  'static __attribute__((noinline)) inline int bend_Edge255_decode','unexpected C');
mutate('decoder-unknown-attribute','boundary','codecs',
  '__attribute__((noinline))','__attribute__((always_inline))','unexpected C');
mutate('primitive-decoder-outline-added','packets','codecs',
  'static inline int bend_U32_decode',
  'static __attribute__((noinline)) inline int bend_U32_decode','unexpected C');
const nested = fixtures.find(f=>f.name==='nested')!;
const natCall = nested.codecs.match(/bend_Nat_decode\(p \+ \d+, 4, &f\d+\)/)![0];
mutate('Nat-callee-erases-bound','nested','codecs',natCall,natCall.replace('bend_Nat_decode','bend_U32_decode'),'decoder child/type/local mapping');
mutate('Nat-guard-dropped','nested','codecs','  if (*out > 64u) return 0;\n','','unexpected C');
mutate('nested-writer-callee','nested','codecs','bend_Small_write(p + 1,','bend_EmptyUnit_write(p + 1,','child writer must be defined before use');
// Adversarial preprocessing must fail closed before text summaries are used.
for (const part of ['native','codecs'] as const) {
  for (const [label, inserted] of [
    ['cr-hidden-return','//\r return 1;\n'], ['cr-hidden-offset','//\r p += 1;\n'],
    ['control-whitespace','\x1c'], ['digraph-directive','%:define return return !\n'],
    ['comment-directive','/**/#define return return !\n'],
  ]) mutate(`${part}-${label}`,'packets',part,'#pragma once',`#pragma once\n${inserted}`,
    label==='comment-directive' ? 'unsupported or non-line-isolated directive' : 'unsupported C preprocessing');
}
mutate('macro-swallows-function','packets','codecs','bend_U32_WIRE_SIZE 4u\n','bend_U32_WIRE_SIZE 4u ',
  'unsupported or non-line-isolated directive');
mutate('wire-tag-truncation','packets','codecs','case 3:\n    p[0] = 3;','case 3:\n    p[0] = 259;','wire tag exceeds byte');
mutate('native-word-signed','packets','native','typedef unsigned int bend_u32;','typedef signed int bend_u32;','unsigned native word');
mutate('comment-separated-writer-call','packets','native','#pragma once',
  '#pragma once\nstatic int hidden(void){return bend_Point_write /**/ (0,0);}', 'native header references a codec identifier');
mutate('native-shadow-decoder','packets','native','#pragma once',
  '#pragma once\nstatic int bend_U32_decode(void){return 1;}', 'native header references a codec identifier');
const packets = fixtures.find(f=>f.name==='packets')!;
const maker = packets.native.match(/static inline bend_Point_t bend_Point_make\([^)]*\) \{[\s\S]*?\n\}/)![0];
mutate('comment-decoy-maker','packets','native',maker,
  `/*${maker}*/\n${maker.replace('static inline','static  inline').replace('.f0 = a0','.f0 = a1')}`, 'native maker');
mutations.push({...structuredClone(packets),name:'trailing-function',
  codecs:packets.codecs+'\nstatic int extra(void){return 1;}\n',expected:'unexpected C'});
// Schema rejection checks are distinct from C mutation checks.
function schemaMutation(name:string, change:(schema:any)=>void, expected:string) {
  const item = structuredClone(nested); change(item.schema); mutations.push({...item,name,expected});
}
schemaMutation('schema-recursion',s=>s.types.find((t:any)=>t.name==='Small').variants[1].fields[0].type='Small','recursive type');
schemaMutation('schema-unknown-child',s=>s.types.find((t:any)=>t.name==='Small').variants[1].fields[0].type='Missing','unknown child type');
schemaMutation('schema-invalid-tag',s=>s.types.find((t:any)=>t.name==='Small').variants[0].tag=1,'variant mapping');
schemaMutation('schema-Nat-bound',s=>s.types.find((t:any)=>t.name==='Nat').max=65,'unsupported primitive identity/bound');
const tooWide=structuredClone(fixtures.find(f=>f.name==='boundary')!);
tooWide.schema.types.find((t:any)=>t.name==='Wide')!.variants[0].fields.push({name:'extra',type:'U32'});
mutations.push({...tooWide,name:'schema-wire-overflow',expected:'wire bound'});
mutate('directive-block-comment-native','packets','native','#pragma once',
  '#pragma once /*\n*/ _Static_assert(0,"swallowed");', 'unsupported or non-line-isolated directive');
mutate('directive-block-comment-wire','packets','codecs','bend_U32_WIRE_SIZE 4u\n',
  'bend_U32_WIRE_SIZE 4u /*\n*/ ', 'unsupported or non-line-isolated directive');
mutate('in-order-wrong-child-writer','nested','codecs','bend_Mixed_write(p + 1,','bend_Small_write(p + 1,','writer child mapping');
mutate('native-pragma-operator','packets','native','#pragma once',
  '#pragma once\n_Pragma("pack(1)")', 'native compiler directive');
mutations.push({...structuredClone(packets),name:'header-name-directive-injection',
  headerName:'packets.h"\n#define return return !\n#include "packets.h',expected:'unsafe native header name'});
const payload = `${directory}/inputs.json`;
fs.writeFileSync(payload, JSON.stringify({fixtures,mutations}));
const result = spawnSync(process.env.PYTHON??'python3',['-B','verification/codec_structures.py',payload,pendingPath],{encoding:'utf8'});
assert.ifError(result.error); assert.equal(result.status,0,result.stderr||result.stdout);
const report = JSON.parse(fs.readFileSync(pendingPath,'utf8'));
assert.equal(report.fixtures.length,selections.length);
assert.equal(report.mutations.length,mutations.length);
const hash = (file:string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
report.inputs = {...report.inputs,...Object.fromEntries([...new Set([...inputs,
  'compiler/primitives.ts','compiler/native-arithmetic.ts','verification/codec_primitives.py','compiler/backend.ts', 'compiler/tagged-sum-ir.ts','compiler/codecs.ts','compiler/schema.ts','compiler/artifacts.ts',
  'verification/check-codec-structures.ts','build/codec-primitives-refinement.json',
])].map(file=>[file,hash(file)]))};
report.toolchain = {bun:process.versions.bun, bend:spawnSync('git',['-C','.deps/bend','rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim()};
fs.writeFileSync(pendingPath,JSON.stringify(report,null,2)+'\n');
fs.renameSync(pendingPath,reportPath);
process.stdout.write(result.stdout);
