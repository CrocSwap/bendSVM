import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Backend, checkedBook } from '../compiler/backend.ts';
import { model } from '../verification/model.ts';
import { testPure, type PureCase } from './pure.ts';

export async function testGenerics() {
  const book=await checkedBook('tests/generics.bend');
  assert.throws(()=>new Backend(book).emit(['box']),/Unsupported runtime function/);
  const recursive=fs.mkdtempSync('build/generic-recursive-');
  try {
    const file=`${recursive}/fixture.bend`;
    fs.writeFileSync(file,`import Base
 type Chain<-T: Data> is Data:
  End{}
  Link{value: T, next: Chain<T>}
 def identity(value: Chain<U32>) -> Chain<U32>:
  value
`.replace(/^ /gm,''));
    await assert.rejects(async()=>new Backend(await checkedBook(file)).emit(['identity']),/Recursive data type/);
  } finally {fs.rmSync(recursive,{recursive:true,force:true});}
  const roots=['word','flag','nested','unwrap','choose_word','choose_flag','present','absent'];
  await testPure('tests/generics.bend',roots,'build/generics',schema=>{
    const box=(type:string,value:any)=>({constructor:`Box<${type}>`,fields:{value}});
    const present=(type:string,value:any)=>({constructor:`Present<${type}>`,fields:{value}});
    const absent=(type:string)=>({constructor:`Absent<${type}>`,fields:{}});
    const cases:PureCase[]=[];
    for(const n of [0,1,0x7fffffff,0x80000000,0xffffffff]) {
      cases.push({name:'word',args:[n],expected:box('U32',n)},
        {name:'nested',args:[n],expected:box('Box<U32>',box('U32',n))},
        {name:'unwrap',args:[box('Box<U32>',box('U32',n))],expected:n},
        {name:'choose_word',args:[present('U32',n),17],expected:n},
        {name:'choose_word',args:[absent('U32'),n],expected:n},
        {name:'present',args:[n],expected:present('U32',n)});
    }
    for(const flag of [false,true])cases.push({name:'flag',args:[flag],expected:box('Bool',flag)},
      {name:'choose_flag',args:[present('Bool',flag),!flag],expected:flag},
      {name:'choose_flag',args:[absent('Bool'),flag],expected:flag});
    cases.push({name:'absent',args:[],expected:absent('Bool')});
    const specialized=schema.types.filter(t=>t.kind==='adt');
    assert.equal(specialized.length,5);
    assert.equal(new Set(specialized.map(t=>t.name)).size,5);
    const reversed=new Backend(book).emit([...roots].reverse()).schema;
    const names=(s:typeof schema)=>s.types.map(t=>t.name).sort();
    assert.deepEqual(names(schema),names(reversed));
    return cases;
  });
  const program=await model('tests/generics.bend',roots);
  fs.writeFileSync('build/generics.model.json',JSON.stringify(program)+'\n');
  const prove=(file:string,expected:number)=>{
    const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/generics.py',file],{encoding:'utf8'});
    assert.equal(result.status,expected,result.stderr||result.stdout);
    const report=JSON.parse(result.stdout);
    assert(report.claims.every((c:any)=>c.result==='unsat'||c.result==='sat'));
    if(expected===1) assert(report.claims.some((c:any)=>c.result==='sat'));
    return report;
  };
  const positive=prove('build/generics.model.json',0);
  const mutations=[];
  const source=fs.readFileSync('tests/generics.bend','utf8');
  for(const [name,before,after] of [
    ['lost generic payload','box(U32, value)','box(U32, 0)'],
    ['wrong generic branch','case Present{value}:\n      value','case Present{value}:\n      other'],
  ]) {
    const dir=fs.mkdtempSync('build/generic-negative-');
    try {
      assert(source.includes(before));
      const file=`${dir}/fixture.bend`;
      fs.writeFileSync(file,source.replace(before,after));
      fs.writeFileSync(`${dir}/model.json`,JSON.stringify(await model(file,roots)));
      mutations.push({name,...prove(`${dir}/model.json`,1)});
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  }
  fs.writeFileSync('build/generics-refinement.json',JSON.stringify({positive,mutations},null,2)+'\n');
  console.log('Generic source refinement: 11 universal claims passed; two source mutations rejected');

  const schema=JSON.parse(fs.readFileSync('build/generics.schema.json','utf8'));
  assert(schema.types.some((t:any)=>t.name==='Box<Box<U32>>'));
}
if(import.meta.main)await testGenerics();
