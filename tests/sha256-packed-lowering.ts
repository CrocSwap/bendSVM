import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildLibrary} from '../compiler/library.ts';
import {emitSha256PackedQualifiedSbf} from '../compiler/sha256-packed-qualified-emission.ts';
import {prepareBend,sbfTools} from '../scripts/build.ts';
import {wireCodec} from '../sdk/wire.ts';

const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run=path.resolve('build/sha256-packed-lowering',crypto.randomUUID());fs.mkdirSync(run,{recursive:true});
const logs:{file:string;sha256:string}[]=[];
function execute(command:string,args:string[],label:string){
 const child=spawnSync(command,args,{encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});const file=path.join(run,label+'.log');fs.writeFileSync(file,(child.stdout??'')+(child.stderr??''));logs.push({file,sha256:hash(file)});assert.ifError(child.error);return child;
}
prepareBend();
const source='tests/sha256-packed-reference/PROOF.bend',root='program.hash_packed',stem=path.join(run,'library');
const ordinary=await buildLibrary(source,root,stem),qualified=await emitSha256PackedQualifiedSbf(source,[root]);
const strip=(s:string)=>s.replace(/^#pragma once\s*$/gm,'');const wrapper=fs.readFileSync(stem+'.c','utf8'),region=strip(qualified.originalEmission.c);
assert.equal(wrapper.split(region).length,2);assert.deepEqual(JSON.parse(fs.readFileSync(stem+'.schema.json','utf8')).schema,qualified.schema);
const qualifiedC='#include "bend_sha256.h"\n'+wrapper.replace(region,strip(qualified.c));
const schema=qualified.schema,codec=wireCodec(schema),exported=schema.exports[0];
const type=(name:string):any=>{const t=schema.types.find(t=>t.name===name);assert(t);return t;};
const construct=(name:string,next:()=>number):any=>{const t=type(name);if(t.kind==='u32')return next();assert.equal(t.variants.length,1);const v=t.variants[0];return {constructor:v.name,fields:Object.fromEntries(v.fields.map((f:any)=>[f.name,construct(f.type,next)]))};};
const rows:{name:string;input:number[];expected:number[];status:number;length:number;active:number[];digest:number[]}[]=[];
function add(name:string,length:number,active:Buffer,poison:number){
 const packed=Buffer.alloc(160,poison);active.copy(packed);let i=0;const message=construct(exported.args[0],()=>i++===0?length:packed.readUInt32LE((i-2)*4));assert.equal(i,41);
 const input=Array.from(codec.encode(exported.args[0],message));assert.equal(input.length,204);
 const result=type(exported.result),accepted=length<=151,v=result.variants[accepted?1:0];let output:any={constructor:v.name,fields:{}};let digest=Buffer.alloc(0);
 if(accepted){digest=crypto.createHash('sha256').update(active).digest();let j=0;output.fields.digest=construct(v.fields[0].type,()=>digest.readUInt32BE(j++*4));assert.equal(j,8);}
 const expected=Array.from(codec.encode(exported.result,output));assert.equal(expected.length,34);rows.push({name,input,expected,status:0,length:accepted?length:0,active:accepted?Array.from(active):[],digest:Array.from(digest)});
}
for(let n=0;n<=151;n++)for(const poison of [0,255])add(`length-${n}-poison-${poison}`,n,Buffer.from(Array.from({length:n},(_,i)=>(128+i*37+n*11)&255)),poison);
add('abc',3,Buffer.from('abc'),165);for(const n of [152,160,0xffffffff])add('rejected-'+n,n,Buffer.alloc(0),255);
const malformed=[...rows[0].input];malformed[0]=255;rows.push({name:'malformed-tag',input:malformed,expected:Array(34).fill(165),status:4,length:0,active:[],digest:[]});assert.equal(rows.length,309);
fs.writeFileSync(path.join(run,'cases.json'),JSON.stringify(rows,null,2)+'\n');
const a=(values:number[],size:number)=>'{'+[...values,...Array(size-values.length).fill(0)].join(',')+'}';
fs.writeFileSync(path.join(run,'cases.h'),'static const struct { unsigned char input[204],expected[34],active[151],digest[32]; unsigned status,length; } cases[]={\n'+rows.map(r=>'{'+[a(r.input,204),a(r.expected,34),a(r.active,151),a(r.digest,32),r.status,r.length].join(',')+'}').join(',\n')+'\n};\n');
fs.writeFileSync(path.join(run,'harness.c'),`#include "library.h"
#include "bend_sha256.h"
#include <stdio.h>
#include <string.h>
#include "cases.h"
static unsigned current,calls,errors,failure;
u64 sol_sha256(const u8 *raw,u64 count,u8 *out){
 const BendSha256Slice *s=(const BendSha256Slice *)raw;calls++;
 if(count!=1||s[0].len!=cases[current].length||memcmp(s[0].data,cases[current].active,cases[current].length)){errors++;fprintf(stderr,"syscall input mismatch case %u\\n",current);}
 memcpy(out,cases[current].digest,32);return failure?17:0;
}
int main(int argc,char **argv){
 unsigned qualified=argc>1;failure=argc>2;(void)argv;
 for(current=0;current<sizeof(cases)/sizeof(cases[0]);current++){
  unsigned before=calls;unsigned char out[34];memset(out,165,34);uint64_t length=999;
  unsigned status=BEND_LIBRARY_CALL(cases[current].input,204,out,34,&length);
  if(failure){fprintf(stderr,"syscall error returned instead of trapping\\n");return 9;}
  if(status!=cases[current].status||length!=(status==0?34:999)||memcmp(out,cases[current].expected,34)){errors++;fprintf(stderr,"output mismatch case %u\\n",current);}
  unsigned expected=qualified&&cases[current].status==0&&cases[current].expected[0]==1;
  if(calls-before!=expected){errors++;fprintf(stderr,"call-count mismatch case %u\\n",current);}
 }
 printf("309 cases, %u calls, %u errors\\n",calls,errors);return errors?1:0;
}
`);
const inputs:Record<string,string>={...Object.fromEntries([import.meta.path,'compiler/library.ts','scripts/build.ts','sdk/wire.ts',path.join(run,'cases.json'),path.join(run,'cases.h'),path.join(run,'harness.c')].map(file=>[path.resolve(file),hash(file)])),...ordinary.inputs};
for(const item of qualified.receipt.sourceInputs)inputs[item.path]=item.sha256;
for(const [name,digest] of Object.entries(qualified.receipt.supportInputs))if(!name.includes('#')&&!name.startsWith('toolchain/'))inputs[path.resolve(name)]=digest;
for(const [name,record] of Object.entries(ordinary.artifacts))inputs[path.join(run,name)]=record.sha256;
const requireInputs=()=>{for(const [file,digest] of Object.entries(inputs))assert.equal(hash(file),digest,file);};requireInputs();
const cc=process.env.CC??'clang',harness=path.join(run,'harness.c');const records:any[]=[];
const located=spawnSync('which',[cc],{encoding:'utf8'});assert.ifError(located.error);assert.equal(located.status,0,located.stderr);const hostCompiler=fs.realpathSync(located.stdout.trim());inputs[hostCompiler]=hash(hostCompiler);const hostVersion=execute(cc,['--version'],'host-compiler-version');assert.equal(hostVersion.status,0);
const mutations:[string,string,string][]=[['length-guard','sha256_packed_length > 151u','sha256_packed_length > 150u'],['byte-order',' >> 0u) & 255u',' >> 8u) & 255u'],['slice-length','.len = (u64)sha256_packed_length','.len = 0u'],['digest-order','sha256_packed_digest[0] << 24','sha256_packed_digest[0] << 0']];
const configs:[string,string][]=[['ordinary',wrapper],['qualified',qualifiedC],...mutations.map(([name,before,after]):[string,string]=>{assert(qualifiedC.includes(before));return [name,qualifiedC.replace(before,after)];})];
for(const [name,c] of configs){
 const file=path.join(run,name+'.c'),binary=path.join(run,name);fs.writeFileSync(file,c);
 const args=['-std=c17','-O1','-Wall','-Wextra','-Werror','-Wno-unused-function','-fsanitize=address,undefined','-fno-sanitize-recover=all','-Iruntime','-I'+run,file,harness,'-o',binary];
 const compile=execute(cc,args,name+'-compile');assert.equal(compile.status,0,compile.stderr);
 const child=execute(binary,name==='ordinary'?[]:['qualified'],name);assert.equal(child.status,name==='ordinary'||name==='qualified'?0:1,child.stderr);
 if(name!=='ordinary'&&name!=='qualified')assert.match(child.stderr,/mismatch case/);records.push({name,compileExit:compile.status,exit:child.status,sourceSha256:hash(file),binarySha256:hash(binary),stdout:child.stdout});
}
const failure=execute(path.join(run,'qualified'),['qualified','fail'],'syscall-error');assert(['SIGILL','SIGTRAP'].includes(failure.signal??''));
const ignored=path.join(run,'ignored-error.c');assert.equal(qualifiedC.split('__builtin_trap();').length,2);fs.writeFileSync(ignored,qualifiedC.replace('__builtin_trap();','(void)0;'));
const ignoredBinary=path.join(run,'ignored-error');const compiled=execute(cc,['-std=c17','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all','-Iruntime','-I'+run,ignored,harness,'-o',ignoredBinary],'ignored-compile');assert.equal(compiled.status,0,compiled.stderr);
const ignoredResult=execute(ignoredBinary,['qualified','fail'],'ignored-error');assert.equal(ignoredResult.status,9);assert.match(ignoredResult.stderr,/instead of trapping/);
// Compile the actual qualified wrapper for SBF and inspect its imports and stack.
const tools=sbfTools(),clang=path.join(tools,'clang'),readelf=path.join(tools,'llvm-readelf');inputs[clang]=hash(clang);inputs[readelf]=hash(readelf);
const obj=path.join(run,'qualified.sbf.o');const compiledSbf=execute(clang,['--target=sbf','-mcpu=generic','-O2','-fPIC','-ffreestanding','-fno-builtin','-fno-stack-protector','-std=c17','-Wframe-larger-than=4096','-fstack-usage','-Iruntime','-c',path.join(run,'qualified.c'),'-o',obj],'sbf-compile');assert.equal(compiledSbf.status,0,compiledSbf.stderr);
const objectBefore=hash(obj);const inspected=execute(readelf,['-s',obj],'sbf-symbols');assert.equal(inspected.status,0);
const imports=inspected.stdout.split('\n').filter(l=>/\bUND\b/.test(l)).map(l=>l.trim().split(/\s+/).at(-1)!).filter(n=>n!=='UND');assert(imports.includes('abort')&&imports.includes('sol_sha256'));assert(imports.every(n=>['abort','sol_sha256','memcpy','memmove','memset'].includes(n)));
const stack=fs.readFileSync(obj.replace(/\.o$/,'.su'),'utf8').trim().split('\n').map(row=>{const [,bytes,kind]=row.split('\t');assert.equal(kind,'static');assert(/^\d+$/.test(bytes));assert(Number(bytes)<=4096);return Number(bytes);});assert.equal(hash(obj),objectBefore);requireInputs();
const artifacts=Object.fromEntries(fs.readdirSync(run).filter(n=>n!=='report.json').map(n=>[n,hash(path.join(run,n))]));
fs.writeFileSync(path.join(run,'report.json'),JSON.stringify({passed:true,cases:rows.length,nativeExecutions:rows.length*2,mutantsRejected:4,syscallFailureSignal:failure.signal,ignoredFailureExit:ignoredResult.status,records,logs,inputs,artifacts,qualification:qualified.receipt,object:{sha256:objectBefore,imports,maxFrameBytes:Math.max(...stack)},hostCompiler:{path:hostCompiler,sha256:inputs[hostCompiler],version:hostVersion.stdout},scope:'Fresh ordinary emitted-C parity vs Node SHA and qualified stub exact byte/length/count/output/error semantics under ASan/UBSan. Qualified SBF object compiled and inspected. No real SHA syscall execution, final linked ELF authorization, universal SHA equivalence or end-to-end compiler claim.'},null,2)+'\n');console.log(JSON.stringify({passed:true,cases:rows.length,nativeExecutions:rows.length*2,mutants:4,maxFrameBytes:Math.max(...stack),report:path.join(run,'report.json')}));

export const packedLoweringRun = run;
