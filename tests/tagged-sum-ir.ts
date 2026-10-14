import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Backend, checkedProgram} from '../compiler/backend.ts';
import {lowerConstruct, lowerCase, renderConstruct, renderCase, validateSumIR,
  type SumFamily, type SumSource, type ConstructIR, type CaseIR} from '../compiler/tagged-sum-ir.ts';

const dir = 'build/tagged-sum-ir';
fs.mkdirSync(dir, {recursive:true});
const reportPath = `${dir}/report.json`;
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (fs.existsSync(reportPath)) fs.renameSync(reportPath, `${dir}/report-${hash(reportPath)}.json`);
const sourceFiles = ['tests/tagged-sum-ir.ts', 'package.json', ...fs.readdirSync('compiler')
  .filter(name => name.endsWith('.ts')).map(name => `compiler/${name}`)];
const before = Object.fromEntries(sourceFiles.map(file => [file, hash(file)]));
const family: SumFamily = {name:'Box<U32>', variants:[
  {name:'None_u32', sourceName:'None', tag:0, maker:'bend_None_u32_make', fields:[]},
  {name:'Pair_u32', sourceName:'Pair', tag:1, maker:'bend_Pair_u32_make',
    fields:[{name:'left', type:'U32'}, {name:'right', type:'U32'}]},
]};
const constructSource: SumSource = {constructor:'Pair', arguments:['U32','U32']};
const caseSource: SumSource = {constructor:'Pair', arguments:['Box<U32>','Nat','U32']};
const construct = lowerConstruct(family, constructSource);
const match = lowerCase(family, caseSource);
assert.equal(renderConstruct(family, constructSource, construct, ['left','right']),
  'bend_Pair_u32_make(left, right)');
assert.equal(renderConstruct(family, {constructor:'None',arguments:[]},
  lowerConstruct(family, {constructor:'None',arguments:[]}), []), 'bend_None_u32_make()');
const values = [{type:'Box<U32>',code:'box'},
  {type:'Nat',code:'fuel',descent:{argument:1,depth:2}}, {type:'U32',code:'tail'}];
const routed = renderCase(family, caseSource, match, values);
assert.equal(routed.condition, '(box).tag == 1u');
assert.deepEqual(routed.hit.map(x => x.code), ['(box).as.c1.f0','(box).as.c1.f1','fuel','tail']);
assert.strictEqual(routed.hit[2], values[1], 'bounded-iteration descent metadata must survive routing');
assert.deepEqual(routed.miss, values);
const nullCaseSource = {...caseSource, constructor:'None'};
assert.deepEqual(renderCase(family, nullCaseSource, lowerCase(family, nullCaseSource), values).hit,
  values.slice(1));

const rejected: string[] = [];
function reject(name: string, original: ConstructIR | CaseIR, source: SumSource,
    mutate: (ir: any) => void) {
  const ir = structuredClone(original); mutate(ir);
  assert.throws(() => validateSumIR(family, source, ir), /Tagged-sum IR:/, name);
  assert.throws(() => original.kind === 'construct'
    ? renderConstruct(family, source, ir as ConstructIR, ['left','right'])
    : renderCase(family, source, ir as CaseIR, values), /Tagged-sum IR:/, `${name}: mandatory renderer gate`);
  rejected.push(name);
}
for (const [name, mutate] of [
  ['wrong tag', (ir:any) => ir.tag=0], ['wrong family',(ir:any) => ir.family='Other'],
  ['wrong identity',(ir:any) => ir.constructor='None_u32'],
  ['unknown operation',(ir:any) => ir.kind='opaque'], ['extra property',(ir:any) => ir.extra=1],
] as const) reject(name, construct, constructSource, mutate);
reject('constructor swapped arguments', construct, constructSource, ir => ir.arguments.reverse());
reject('constructor missing argument', construct, constructSource, ir => ir.arguments.pop());
reject('constructor wrong type', construct, constructSource, ir => ir.arguments[0].type='Bool');
reject('scrutinee index', match, caseSource, ir => ir.scrutinee.index=1);
reject('field index', match, caseSource, ir => ir.hit[0].index=1);
reject('field tag', match, caseSource, ir => ir.hit[0].tag=0);
reject('field base', match, caseSource, ir => ir.hit[0].argument=1);
reject('field type', match, caseSource, ir => ir.hit[0].type='Bool');
reject('field argument substitution', match, caseSource, ir => ir.hit[0]={kind:'argument',index:0,type:'U32'});
reject('match tail order', match, caseSource, ir => ir.hit[2].index=2);
reject('miss drops scrutinee', match, caseSource, ir => ir.miss.shift());
reject('miss changes arguments', match, caseSource, ir => ir.miss.reverse());

const fixtureSpecs = [
  {file:'tests/lowering.bend', roots:['swap','select','update','normalize','iterate','identity']},
  {file:'tests/generics.bend', roots:['choose_word','choose_flag','nested','unwrap','present','absent']},
  {file:'examples/queue/PROOF.bend', roots:['queue.run_fold']},
];
const inputHashes: Record<string,string> = {};
const emissions = [];
for (const fixture of fixtureSpecs) {
  const checked = await checkedProgram(fixture.file);
  for (const file of checked.files) inputHashes[file] = hash(file);
  emissions.push(new Backend(checked.book).emit(fixture.roots));
}
const emitted = emissions[0];
const operations = emissions.flatMap(e => e.taggedSumLowering.operations);
assert(operations.some(x => x.ir.kind === 'construct'));
assert(operations.some(x => x.ir.kind === 'case' && x.source.arguments.length > 1), 'production trailing arguments');
assert(operations.some(x => x.ir.kind === 'case' && x.family.variants.some(v => v.sourceName)), 'production generic family');
assert(operations.some(x => x.ir.kind === 'case' && x.source.arguments.slice(1).includes('Nat')), 'production Nat counter');
for (const evidence of operations) validateSumIR(evidence.family, evidence.source, evidence.ir);

// Mutate the real producer used by Backend, in a private copy. A standalone
// checker test cannot establish that production emission invokes the checker.
const privateDir = fs.mkdtempSync(path.resolve(dir, 'producer-'));
fs.cpSync('compiler', `${privateDir}/compiler`, {recursive:true});
fs.symlinkSync(path.resolve('.deps'), `${privateDir}/.deps`, 'dir');
const irFile = `${privateDir}/compiler/tagged-sum-ir.ts`;
const original = fs.readFileSync(irFile,'utf8');
const runner = `${privateDir}/run.ts`;
const fixtureCode = JSON.stringify(fixtureSpecs.map(f => ({...f,file:path.resolve(f.file)})));
fs.writeFileSync(runner, `import {Backend, checkedBook} from './compiler/backend.ts';
try { for (const fixture of ${fixtureCode}) {
 const book = await checkedBook(fixture.file); new Backend(book).emit(fixture.roots); } }
catch (e) { if (e instanceof Error && e.message.startsWith('Tagged-sum IR:')) {
 console.log('EXPECTED_IR_REJECTION: ' + e.message); process.exit(0); } throw e; }
throw new Error('Malformed production IR was accepted');\n`);
const producerMutations = [
  ['case trailing hit index', 'source.arguments.slice(1).map((type, i) => argument(i + 1, type))',
    'source.arguments.slice(1).map((type, i) => argument(i + 2, type))'],
  ['constructor tag', "kind: 'construct', family: family.name, constructor: v.name, tag: v.tag,",
    "kind: 'construct', family: family.name, constructor: v.name, tag: v.tag + 1,"],
  ['constructor argument', 'arguments: source.arguments.map((type, i) => argument(i, type))};', 'arguments: source.arguments.map((type, i) => argument(i + 1, type))};'],
  ['case field index', 'tag: v.tag, index: i, type: f.type}', 'tag: v.tag, index: i + 1, type: f.type}'],
  ['case fallback index', 'miss: source.arguments.map((type, i) => argument(i, type))',
    'miss: source.arguments.map((type, i) => argument(i + 1, type))'],
];
const producerResults: {name:string; result:string}[] = [];
for (const [name, target, replacement] of producerMutations) {
  assert.equal(original.split(target).length-1, 1, `${name}: unique mutation target`);
  fs.writeFileSync(irFile, original.replace(target, replacement));
  const child = spawnSync(process.execPath, [runner], {encoding:'utf8', timeout:60_000});
  fs.writeFileSync(`${privateDir}/${name.replaceAll(' ','-')}.log`, child.stdout + child.stderr);
  assert.ifError(child.error);
  assert.equal(child.status,0, child.stderr || child.stdout);
  assert.match(child.stdout,/EXPECTED_IR_REJECTION: Tagged-sum IR:/);
  producerResults.push({name,result:'production emission rejected malformed IR'});
}
const rendererReturn = `  return {condition: \`(\${values[ir.scrutinee.index].code}).tag == \${ir.tag}u\`,
    hit: ir.hit.map(route), miss: ir.miss.map(a => values[a.index])};`;
assert.equal(original.split(rendererReturn).length-1, 1);
const observedRenderer = rendererReturn.replace('return {condition:', 'const result = {condition:') + `
  for (let i = 1; i < values.length; i++) if (values[i].type === 'Nat' && (values[i] as any).descent) {
    const hitAt = ir.hit.findIndex(ref => ref.kind === 'argument' && ref.index === i);
    if (result.hit[hitAt] !== values[i] || result.miss[i] !== values[i])
      throw new Error('PRODUCTION_NAT_ROUTING_FAILED');
    console.log('PRODUCTION_NAT_ROUTING_PRESERVED');
  }
  return result;`;
fs.writeFileSync(irFile, original.replace(rendererReturn, observedRenderer));
fs.writeFileSync(runner, `import {Backend, checkedBook} from './compiler/backend.ts';
for (const fixture of ${fixtureCode}) new Backend(await checkedBook(fixture.file)).emit(fixture.roots);`);
const natProbe = spawnSync(process.execPath, [runner], {encoding:'utf8',timeout:60_000});
assert.ifError(natProbe.error); assert.equal(natProbe.status,0,natProbe.stderr);
assert.match(natProbe.stdout,/PRODUCTION_NAT_ROUTING_PRESERVED/);
fs.writeFileSync(`${privateDir}/nat-routing.log`,natProbe.stdout);
fs.writeFileSync(irFile, original);
for (const [file, expected] of Object.entries({...before,...inputHashes}))
  assert.equal(hash(file), expected, `input changed during check: ${file}`);
fs.writeFileSync(`${dir}/emitted.c`, emitted.c);
fs.writeFileSync(reportPath, JSON.stringify({passed:true, scope:
  'Production constructor/match routing checks relative to trusted runtime schema and opaque expressions; not semantic preservation of the full compiler or C/SBF.',
  sourceHashes:before, inputHashes, operations:{version:1,operations}, fixtureSpecs,
  rejected, producerResults, generatedC:hash(`${dir}/emitted.c`)}, null,2)+'\n');
console.log(`${operations.length} production operations, ${rejected.length} malformed IR cases, ${producerResults.length} production mutations checked`);
