import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Backend,checkedBook} from '../compiler/backend.ts';
import {TargetDiagnostic} from '../compiler/diagnostics.ts';
import {wireLayouts,type RuntimeSchema} from '../compiler/schema.ts';
import {emitCollectionStorage} from '../compiler/collection-storage.ts';
import {resourceReport} from '../compiler/resources.ts';
import {compileSbf,run} from '../scripts/build.ts';

export async function testDiagnostics() {
  const dir=fs.mkdtempSync('build/diagnostics-');
  try {
    for(const [label,source,root,code] of [
      ['closure','import Base\ndef apply(f: U32 -> U32, x: U32) -> U32:\n  f(x)\n','apply','BEND-SBF100'],
      ['recursive','type Chain is Data:\n  End{}\n  Next{tail: Chain}\ndef identity(value: Chain) -> Chain:\n  value\n','identity','BEND-SBF101'],
    ]) {
      const file=path.join(dir,label+'.bend');fs.writeFileSync(file,source);
      const book=await checkedBook(file);
      assert.throws(()=>new Backend(book).emit([root]),(e:unknown)=>{
        assert(e instanceof TargetDiagnostic);assert.equal(e.code,code);assert.equal(e.functionName,root);
        assert.match(e.message,/Hint:/);assert.equal(e.toJSON().function,root);return true;
      });
      const cli=spawnSync(process.execPath,['scripts/program.ts',file,root,path.join(dir,label)],{encoding:'utf8'});
      assert.equal(cli.status,1,cli.stdout+cli.stderr);assert(cli.stderr.includes(`[${code}]`));
      assert(cli.stderr.includes(`Function: ${root}`));assert(cli.stderr.includes('Hint:'));
      assert(!fs.existsSync(path.join(dir,label+'.so')));
    }
    const schema:RuntimeSchema={version:1,exports:[],types:[{name:'U32',kind:'u32',cType:'bend_u32'},
      {name:'Huge',kind:'adt',cType:'Huge',variants:[{name:'Huge',tag:0,cMaker:'make',fields:Array.from({length:256},(_,i)=>({name:`f${i}`,type:'U32'}))}]}]};
    assert.throws(()=>wireLayouts(schema),(e:unknown)=>e instanceof TargetDiagnostic&&e.code==='BEND-SBF201'&&e.message.includes('1025 bytes'));
    const emitted=new Backend(await checkedBook('tests/collection-store.bend')).emit(['process','select']);
    const resources=resourceReport(emitted.schema);
    const native=path.join(dir,'layout.c');
    fs.writeFileSync(native,emitted.c.replace('#pragma once','')+'\n'+resources.layouts.map(l=>{
      const t=emitted.schema.types.find(t=>t.name===l.type)!;
      return `_Static_assert(sizeof(${t.cType})==${l.nativeBytes}, "reported native layout differs");`;
    }).join('\n')+'\nint main(void){return 0;}\n');
    run(process.env.CC??'clang',['-std=c17','-Wall','-Werror','-Wno-unused-function',native,'-o',path.join(dir,'layout')]);
    run(path.join(dir,'layout'),[]);
    const huge=path.join(dir,'huge.bend');
    fs.writeFileSync(huge,'import Base\ntype Huge is Data:\n  Huge{'+Array.from({length:384},(_,i)=>`f${i}: U32`).join(', ')+'}\ndef identity(value: Huge) -> Huge:\n  value\n');
    const hugeBook=await checkedBook(huge);
    assert.throws(()=>new Backend(hugeBook).emit(['identity']),(e:unknown)=>e instanceof TargetDiagnostic&&e.code==='BEND-SBF202'&&e.message.includes('1540 native bytes'));
    const stack=path.join(dir,'stack.c');
    fs.writeFileSync(stack,'#include "solana_min.h"\nu64 entrypoint(const u8 *input){volatile u8 data[5000];for(unsigned i=0;i<5000;i++)data[i]=input[i&7];sol_set_return_data((const u8*)data,5000);return data[0];}\n');
    assert.throws(()=>compileSbf(stack,path.join(dir,'stack')),(e:unknown)=>e instanceof TargetDiagnostic&&e.code==='BEND-SBF203');
    assert.throws(()=>emitCollectionStorage(emitted.schema,'process',{select:'select',element:'Missing'}),
      (e:unknown)=>e instanceof TargetDiagnostic&&e.code==='BEND-SBF300'&&e.message.includes('unknown element Missing'));
    console.log('Target diagnostic categories, function context, hints and CLI exit checks passed');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
if(import.meta.main)await testDiagnostics();
