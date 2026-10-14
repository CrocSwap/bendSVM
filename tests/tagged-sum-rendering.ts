import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fixtures,digest} from '../verification/check-tagged-sum-routing.ts';

const directory=path.resolve('build/tagged-sum-rendering-tests',randomUUID());
fs.mkdirSync(directory,{recursive:true});
fs.cpSync('compiler',`${directory}/compiler`,{recursive:true});
fs.symlinkSync(path.resolve('.deps'),`${directory}/.deps`,'dir');
const renderer=`${directory}/compiler/tagged-sum-ir.ts`;
const original=fs.readFileSync(renderer,'utf8');
const specs=fixtures.map(f=>({...f,file:path.resolve(f.file)}));
const runner=`${directory}/export.ts`;
fs.writeFileSync(runner,`import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {Backend,checkedProgram} from './compiler/backend.ts';
const operations:any[]=[],artifacts:any[]=[];
for(const fixture of ${JSON.stringify(specs)}) {
 const emitted=new Backend((await checkedProgram(fixture.file)).book).emit(fixture.roots);
 artifacts.push({fixture:fixture.file,c:emitted.c,cSha256:createHash('sha256').update(emitted.c).digest('hex'),
  schema:emitted.schema,operationOffset:operations.length,renderings:emitted.taggedSumLowering.rendered.operations});
 operations.push(...emitted.taggedSumLowering.operations);
}
fs.writeFileSync(process.argv[2],JSON.stringify({operations,artifacts}));\n`);
function exportArtifacts(name:string) {
  const file=`${directory}/${name}.json`;
  const result=spawnSync(process.execPath,[runner,file],{encoding:'utf8',timeout:60_000});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
  return file;
}
function check(file:string) {
  return spawnSync(process.env.PYTHON??'python3',['-B','-c',
    "import json,sys;sys.path.insert(0,'verification');from tagged_sum_rendering import check_renderings;from tagged_sum_layout import check_layouts;d=json.load(open(sys.argv[1]));check_layouts(d['artifacts']);print(len(check_renderings(d['artifacts'],d['operations'])))",file],
    {encoding:'utf8',timeout:30_000});
}
const baselineFile=exportArtifacts('baseline');
const positive=check(baselineFile);assert.equal(positive.status,0,positive.stderr);assert.equal(positive.stdout.trim(),'100');
const results=[];
const mutations=[
  ['constructor-argument-order',"ir.arguments.map(a => values[a.index])", "[...ir.arguments].reverse().map(a => values[a.index])",/constructor expression differs/],
  ['match-tag', '${ir.tag}u', '${ir.tag + 1}u',/condition differs/],
  ['projected-field', '${ref.index}', '${ref.index + 1}',/hit expressions differ/],
  ['hit-order', 'hit: ir.hit.map(route)', 'hit: ir.hit.map((ref, i) => ({...route(ref), code: route(ir.hit[ir.hit.length-i-1]).code}))',/hit expressions differ/],
  ['miss-expression', 'miss: ir.miss.map(a => values[a.index])', "miss: ir.miss.map(a => ({...values[a.index], code:'0u'}))",/miss expressions differ/],
] as const;
for(const [name,target,replacement,reason] of mutations) {
  assert.equal(original.split(target).length-1,1,name+' mutation anchor');
  fs.writeFileSync(renderer,original.replace(target,replacement));
  // Some wrong renderings can make downstream backend typing reject. These
  // controls deliberately preserve typed values, so require successful emit
  // and rejection by the independent C-expression checker itself.
  const file=exportArtifacts(name);
  const result=check(file);assert.notEqual(result.status,0,name);assert.match(result.stderr,reason);
  fs.writeFileSync(`${directory}/${name}.log`,result.stdout+result.stderr);
  results.push({name,result:'independent rendering rejection',artifactSha256:digest(fs.readFileSync(file))});
}
fs.writeFileSync(renderer,original);
const restored=exportArtifacts('restored');
assert.deepEqual(JSON.parse(fs.readFileSync(restored,'utf8')),JSON.parse(fs.readFileSync(baselineFile,'utf8')));
assert.equal(check(restored).status,0);
// Alter actual C while leaving renderer records untouched. Compile the two
// semantic faults to establish a real behavior change, then require rejection.
const baseline=JSON.parse(fs.readFileSync(baselineFile,'utf8'));
const cFaults: {name:string; target:string; replacement:string; reason:RegExp; expected?:string; expectedBaseline?:string; expression?:string; artifact?:number}[]=[
  {name:'unused-correct-call-wrong-return',target:'return bend_Present_3c_U32_3e__make(a0);',
    replacement:'(void)bend_Present_3c_U32_3e__make(a0);\n  return bend_Present_3c_U32_3e__make(0u);',
    reason:/constructor call inventory/,expected:'0',expression:'bend_present(7u).as.c1.f0'},
  {name:'digraph-condition-macro',target:'#pragma once',replacement:'#pragma once\n%:define if(x) if(1)',
    reason:/unsupported C digraph/,expected:'9',expression:'bend_choose_5f_word(bend_present(7u),9u)'},
  {name:'duplicate-constructor-call',target:'return bend_Present_3c_U32_3e__make(a0);',
    replacement:'(void)bend_Present_3c_U32_3e__make(a0);\n  return bend_Present_3c_U32_3e__make(a0);',
    reason:/constructor call inventory/},
  {name:'missing-constructor-call',target:'return bend_Present_3c_U32_3e__make(a0);',
    replacement:'return (bend_Choice_3c_U32_3e__t){.tag=1,.as.c1={.f0=a0}};',reason:/constructor call inventory/},
];
function functionSpan(c:string,name:string):[number,number] {
  const marker=name+'('; const at=c.indexOf(marker);assert.ok(at>=0);
  const start=c.indexOf('{',at)+1;assert.ok(start>0);let depth=1;
  for(let end=start;end<c.length;end++) {
    if(c[end]==='{') depth++; else if(c[end]==='}') depth--;
    if(depth===0) return [start,end];
  }
  throw Error('unterminated function mutation target');
}
const originalC=baseline.artifacts[0].c;
const first=functionSpan(originalC,'bend_normalize'),second=functionSpan(originalC,'bend_identity');
assert.ok(first[1]<second[0]);
const movedC=originalC.slice(0,first[0])+originalC.slice(second[0],second[1])+
  originalC.slice(first[1],second[0])+originalC.slice(first[0],first[1])+originalC.slice(second[1]);
cFaults.push({name:'moved-block-between-functions',artifact:0,target:originalC,replacement:movedC,
  reason:/inventory/,expectedBaseline:'4294967288',expected:'7',expression:'bend_normalize(bend_Word_make(7u)).as.c1.f0'});
const choiceStart=baseline.artifacts[1].c.indexOf('typedef struct {');
const choiceEnd=baseline.artifacts[1].c.indexOf('} bend_Choice_3c_U32_3e__t;')+'} bend_Choice_3c_U32_3e__t;'.length;
assert.ok(choiceStart>=0 && choiceEnd>choiceStart);
const choiceDeclaration=baseline.artifacts[1].c.slice(choiceStart,choiceEnd);
cFaults.push({name:'narrowed-constructor-field',target:choiceDeclaration,
  replacement:choiceDeclaration.replace('bend_u32 f0;', 'unsigned char f0;'),reason:/declaration differs from schema/,
  expectedBaseline:'4660',expected:'52',expression:'(unsigned int)bend_present(4660u).as.c1.f0'});
const sampleEnd=originalC.indexOf('} bend_Sample_t;')+'} bend_Sample_t;'.length;
const sampleStart=originalC.lastIndexOf('typedef struct {',sampleEnd);
assert.ok(sampleStart>=0 && sampleEnd>sampleStart);
const sampleDeclaration=originalC.slice(sampleStart,sampleEnd);
for(const [name,target,replacement] of [
  ['narrowed-tag','bend_u32 tag;','unsigned char tag;'],
  ['reordered-fields','bend_u32 f0; bend_u32 f1;','bend_u32 f1; bend_u32 f0;'],
  ['wrong-union-member','} c0;','} c9;'],
  ['missing-field','bend_u32 f0; bend_u32 f1;','bend_u32 f0;'],
] as const) {
  assert.equal(sampleDeclaration.split(target).length-1,1);
  cFaults.push({name,artifact:0,target:sampleDeclaration,replacement:sampleDeclaration.replace(target,replacement),
    reason:/declaration differs from schema/});
}
cFaults.push({name:'wrong-base-size-assertion',artifact:0,target:'sizeof(bend_u32) == 4',
  replacement:'sizeof(bend_u32) == 8',reason:/missing 32-bit size assertion/});
cFaults.push({name:'wrong-native-bound-assertion',artifact:0,target:'sizeof(bend_Sample_t) <= 1536',
  replacement:'sizeof(bend_Sample_t) <= 2000',reason:/missing native bound assertion/});
const artifactFaults=[];
for(const fault of cFaults) {
  const candidate=structuredClone(baseline), artifact=candidate.artifacts[fault.artifact??1];
  assert.equal(artifact.c.split(fault.target).length-1,1,fault.name+' mutation target');
  artifact.c=artifact.c.replace(fault.target,fault.replacement);artifact.cSha256=digest(artifact.c);
  const file=`${directory}/${fault.name}.json`;fs.writeFileSync(file,JSON.stringify(candidate));
  const rejected=check(file);assert.notEqual(rejected.status,0,fault.name);assert.match(rejected.stderr,fault.reason);
  const outputs:Record<string,string>={};
  if(fault.expression) for(const [label,data] of [['baseline',baseline],['mutant',candidate]] as const) {
    const source=`${directory}/${fault.name}-${label}.c`, executable=source+'.out';
    fs.writeFileSync(source,data.artifacts[fault.artifact??1].c+'\n#include <stdio.h>\nint main(void) { printf("%u\\n", '+fault.expression+'); return 0; }\n');
    const compiled=spawnSync(process.env.CC??'clang',['-std=c11','-O1',source,'-o',executable],{encoding:'utf8',timeout:30000});
    assert.ifError(compiled.error);assert.equal(compiled.status,0,compiled.stderr);
    const executed=spawnSync(executable,[],{encoding:'utf8',timeout:5000});
    assert.ifError(executed.error);assert.equal(executed.status,0,executed.stderr);outputs[label]=executed.stdout.trim();
  }
  if(fault.expected) assert.deepEqual(outputs,{baseline:fault.expectedBaseline??'7',mutant:fault.expected});
  artifactFaults.push({name:fault.name,result:'rejected',nativeOutputs:outputs});
}
fs.writeFileSync(`${directory}/report.json`,JSON.stringify({passed:true,results,artifactFaults,
  baselineSha256:digest(fs.readFileSync(baselineFile)),rendererSha256:digest(original)},null,2)+'\n');
console.log(`${results.length} production renderer mutations and ${artifactFaults.length} emitted-C faults rejected; original emission restored exactly`);
