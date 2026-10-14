import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {testTreeFold} from './tree-fold.ts';

export async function testTreeFoldControls() {
  const run=path.resolve('build/tree-fold-controls/run-'+randomUUID());
  fs.mkdirSync(run,{recursive:true});
  const sdk=fs.readFileSync('sdk/tree-fold.bend','utf8');
  const fixture=fs.readFileSync('tests/tree-fold.bend','utf8');
  const relocate=(source:string)=>source.replaceAll('../sdk/',path.resolve('sdk')+'/')
    .replaceAll('import ./', 'import '+path.resolve('sdk')+'/');
  const controls=[
    {name:'reverse-full-pair',from:'first = F.combine(T, A, reduce, accumulator, B.Valid{left})\n      F.combine(T, A, reduce, first, B.Valid{right})',
      to:'first = F.combine(T, A, reduce, accumulator, B.Valid{right})\n      F.combine(T, A, reduce, first, B.Valid{left})'},
    {name:'ignore-fuel',from:'U32.is_eq(fuel_value(fuel), length)',to:'U32.is_ge(fuel_value(fuel), 0)'},
    {name:'ignore-reducer-failure',from:'def order_gate(failed: Bool, value: U32) -> B.Result<U32>:\n  match failed:\n    case True{}: B.Invalid{}',
      to:'def order_gate(failed: Bool, value: U32) -> B.Result<U32>:\n  match failed:\n    case True{}: B.Valid{0}',fixture:true},
  ];
  const results=[];
  for(const control of controls) {
    const dir=path.join(run,control.name);fs.mkdirSync(dir);
    const original=control.fixture?fixture:sdk;
    const matches=original.split(control.from).length-1;
    assert.equal(matches,control.name==='ignore-fuel'?2:1,control.name);
    const broken=original.replaceAll(control.from,control.to);
    fs.writeFileSync(path.join(dir,'tree-fold.bend'),relocate(control.fixture?sdk:broken));
    const source=relocate(control.fixture?broken:fixture)
      .replace('import '+path.resolve('sdk/tree-fold.bend')+' as T','import ./tree-fold.bend as T');
    const file=path.join(dir,'fixture.bend');fs.writeFileSync(file,source);
    let failure:unknown;
    try {await testTreeFold(file,path.join(dir,'fixture'));}catch(error){failure=error;}
    assert(failure instanceof Error,control.name+' was not detected');
    assert.equal((failure as Error&{code?:string}).code,'ERR_ASSERTION',control.name);
    assert.match(failure.message,/order4 case \d+/,control.name+' must fail semantically');
    fs.writeFileSync(path.join(dir,'failure.txt'),failure.stack+'\n');
    results.push({name:control.name,detected:true,witness:failure.message,
      fixtureSha256:createHash('sha256').update(source).digest('hex')});
  }
  fs.writeFileSync(path.join(run,'report.json'),JSON.stringify({passed:true,results},null,2)+'\n');
  console.log('Three tree-fold source controls rejected for semantic mismatches: '+run);
}

if(import.meta.main)await testTreeFoldControls();
