import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepareBend} from '../scripts/build.ts';

// Standalone ABI 2 assurance. Every positive and mutated C fixture is written
// by compiler/artifacts.ts with the actual multi-storage layout option, then
// read back from disk with its complete include closure.
const root = process.cwd();
const directory = 'build/multi-adapter-contract';
const payloadPath = 'build/multi-adapter-contract-input.json';
const pythonOutput = 'build/multi-adapter-contract-result.pending.json';
const reportPath = 'build/multi-adapter-contract-refinement.json';
if (fs.existsSync(reportPath)) {
  fs.mkdirSync('build/refinement-reports', {recursive:true});
  const digest=crypto.createHash('sha256').update(fs.readFileSync(reportPath)).digest('hex');
  fs.copyFileSync(reportPath,`build/refinement-reports/${digest}.json`);
}
for (const file of [payloadPath,pythonOutput,reportPath]) fs.rmSync(file,{force:true});
fs.mkdirSync(directory,{recursive:true});
const sha = (file:string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const shaText = (text:string) => crypto.createHash('sha256').update(text).digest('hex');
const immutableInputs:Record<string,string> = {};
const selections = [
  ['pure-2','tests/multi-storage.bend','process','tests/multi-storage.layout.json'],
  ['pure-3','tests/multi-storage-3.bend','process','tests/multi-storage-3.layout.json'],
  ['pure-4','tests/multi-storage-4.bend','process','tests/multi-storage-4.layout.json'],
  ['token-2','tests/multi-token-2.bend','process','tests/multi-token-2.layout.json'],
  ['token-3','tests/multi-token-3.bend','process','tests/multi-token-3.layout.json'],
  ['token-4','tests/multi-token-4.bend','process','tests/multi-token-4.layout.json'],
  ['cpi-2','tests/cpi-multi.bend','process','tests/cpi-multi.layout.json'],
  ['cpi-3','tests/cpi-multi-3.bend','process','tests/cpi-multi-3.layout.json'],
  ['cpi-4','tests/cpi-multi-4.bend','process','tests/cpi-multi-4.layout.json'],
] as const;
const {Backend,checkedProgram} = await import('../compiler/backend.ts');
const {writeArtifacts} = await import('../compiler/artifacts.ts');
const fixtures:any[] = [];
for (const [name,source,entry,layoutPath] of selections) {
  const checked = await checkedProgram(source);
  const emitted = new Backend(checked.book).emit([entry]);
  const layout = JSON.parse(fs.readFileSync(layoutPath,'utf8'));
  const stem = `${directory}/${name}`;
  writeArtifacts(stem,emitted,entry,{stateAccounts:layout.stateAccounts});
  const files:Record<string,string> = {}, paths:Record<string,string> = {};
  const pending = [{file:`${name}.c`, found:`${stem}.c`}];
  while (pending.length) {
    const {file,found} = pending.pop()!;
    if (file in files) {
      assert.equal(path.resolve(paths[file]),path.resolve(found),`${name}: ambiguous include binding ${file}`);
      continue;
    }
    files[file] = fs.readFileSync(found,'utf8'); paths[file] = found;
    for (const match of files[file].matchAll(/^[ \t]*#[ \t]*include[ \t]*(["<])([^">\n]+)[">]/gm)) {
      // Match Clang's quoted-header directory search followed by -Ibuild -Iruntime.
      const search=match[1]==='"'?[path.dirname(found),'build','runtime']:['build','runtime'];
      const resolved=search.map(dir=>path.join(dir,match[2])).find(p=>fs.existsSync(p));
      assert(resolved,`${name}: unresolved include ${match[2]}`);
      pending.push({file:match[2],found:resolved});
    }
  }
  const schemaPath=stem+'.schema.json', interfacePath=stem+'.interface.json';
  const schema=JSON.parse(fs.readFileSync(schemaPath,'utf8'));
  const iface=JSON.parse(fs.readFileSync(interfacePath,'utf8'));
  assert.equal(iface.version,2,`${name}: actual compiler did not emit ABI 2`);
  assert.equal(iface.stateAccounts.length,Number(name.at(-1)),`${name}: wrong account coverage`);
  for (const file of [...checked.files,source,layoutPath,schemaPath,interfacePath,...Object.values(paths)])
    immutableInputs[path.resolve(file)] = sha(file);
  fixtures.push({name,source,root:entry,layoutPath,adapter:`${name}.c`,files,schema,interface:iface,
    schemaFileSha256:sha(schemaPath),interfaceFileSha256:sha(interfacePath),
    artifactPaths:Object.fromEntries(Object.entries(paths).map(([k,v])=>[k,path.resolve(v)])),
    sourceDependencies:Object.fromEntries([...new Set([...checked.files,source,layoutPath])].map(f=>[path.resolve(f),sha(f)]))});
}

type Variant={name:string;fixture:string;files:Record<string,string>;kind?:'semantic'|'grammar';expected?:string};
const mutations:Variant[]=[], equivalents:Variant[]=[];
const once=(text:string,search:string,replacement:string,label:string)=>{
  const count=text.split(search).length-1;
  assert.equal(count,1,`mutation target must occur once: ${label} (${count})`);
  return text.replace(search,replacement);
};
const add=(name:string,fixture:string,file:string,text:string,kind:'semantic'|'grammar',expected:string)=>{
  mutations.push({name,fixture,files:{[file]:text},kind,expected});
};
const byName=(name:string)=>fixtures.find(f=>f.name===name)!;
const ident=(name:string)=>'bend_'+[...name].map(c=>/[A-Za-z0-9]/.test(c)?c:`_${c.codePointAt(0)!.toString(16)}_`).join('');

// Field-by-field ABI and trace mutations exercise the parser and symbolic
// executor over four-state written adapters, including the last commit slot.
const token4=byName('token-4'), c4=token4.files[token4.adapter];
const tokenFields=token4.interface.stateAccounts;
for (let i=0;i<tokenFields.length;i++) {
  const a=tokenFields[i], ctype=token4.schema.types.find((t:any)=>t.name===a.type).cType;
  const owner=`if (!equal_key(state${i}.owner,program) || state${i}.executable) return 3;`;
  add(`field-${i}: wrong owner binding`,'token-4',token4.adapter,
    once(c4,owner,`if (state${i}.executable) return 3;`,`owner-${i}`),'semantic','ordered-return-contract');
  const writable=`if (!state${i}.writable) return 5;`;
  add(`field-${i}: writable flag omitted`,'token-4',token4.adapter,
    once(c4,writable,'','writable-'+i),'semantic','ordered-return-contract');
  const size=`if (state${i}.size != ${a.stateBytes}) return 4;`;
  add(`field-${i}: wrong size`,'token-4',token4.adapter,
    once(c4,size,`if (state${i}.size != ${a.stateBytes+1}) return 4;`,`size-${i}`),'semantic','ordered-return-contract');
  const header=`const u8 header${i}[20]={${a.header.join(',')}};`;
  const badHeader=[...a.header]; badHeader[0]^=1;
  add(`field-${i}: wrong ABI2 header`,'token-4',token4.adapter,
    once(c4,header,`const u8 header${i}[20]={${badHeader.join(',')}};`,`header-${i}`),'semantic',
    'ordered-return-contract');
  const bindingBytes=a.bindingBytes, payloadSize=a.stateBytes-20-bindingBytes;
  if (i>0) {
    const binding=`if(!equal_key(state${i}.data+20,state0.key)) return 4;`;
    add(`field-${i}: binding uses wrong offset`,'token-4',token4.adapter,
      once(c4,binding,`if(!equal_key(state${i}.data+21,state0.key)) return 4;`,`binding-${i}`),'semantic','ordered-return-contract');
  }
  const decode=`if(!${ident(a.type)}_decode(state${i}.data+${20+bindingBytes},${payloadSize},&before${i})) return 4;`;
  add(`field-${i}: decoder payload offset`,'token-4',token4.adapter,
    once(c4,decode,`if(!${ident(a.type)}_decode(state${i}.data+${21+bindingBytes},${payloadSize},&before${i})) return 4;`,`decode-offset-${i}`),
    'semantic','bounds');
  const source=`&after->as.c0.f${i}`;
  const wrongSource=`&after->as.c0.f${(i+1)%tokenFields.length}`;
  add(`field-${i}: wrong encode source`,'token-4',token4.adapter,
    once(c4,source,wrongSource,`encode-source-${i}`),'semantic','encode-source-field-binding');
  const payload=`__builtin_memcpy(state${i}.data+${20+bindingBytes},encoded${i},${payloadSize});`;
  const wrongTarget=i===0?`state1.data+20`:`state0.data+20`;
  add(`field-${i}: wrong commit target`,'token-4',token4.adapter,
    once(c4,payload,`__builtin_memcpy(${wrongTarget},encoded${i},${payloadSize});`,`commit-target-${i}`),
    'semantic','exact-per-account-header-binding-payload-and-reply');
  const encode=`if(!${ident(a.type)}_encode(encoded${i},${payloadSize},&after->as.c0.f${i})) return 9;`;
  add(`field-${i}: ignored partial encode failure`,'token-4',token4.adapter,
    once(c4,encode,`${ident(a.type)}_encode(encoded${i},${payloadSize},&after->as.c0.f${i});`,`partial-encode-${i}`),
    'semantic','obligation');
}
const completeReplyCall=c4.match(/bend_[A-Za-z0-9_]+_encode\(reply,\d+,after\)/)?.[0];
assert(completeReplyCall,'complete record reply encoder call missing');
add('complete reply encoder uses before-state','token-4',token4.adapter,
  once(c4,completeReplyCall,completeReplyCall.replace(',after)',',&before)'),'complete-reply-source'),
  'semantic','encode-source-field-binding');
const tokenStateType=token4.schema.types.find((t:any)=>t.name===token4.interface.state);
const maker=tokenStateType.variants[0].cMaker;
const makeCall=`${maker}(${tokenFields.map((_:any,i:number)=>`before${i}`).join(',')})`;
const swapped=`${maker}(before1,before0,${tokenFields.slice(2).map((_:any,i:number)=>`before${i+2}`).join(',')})`;
add('before fields swapped','token-4',token4.adapter,once(c4,makeCall,swapped,'before-swap'),'semantic','root-context-before-instruction');
const rootCall=`${token4.schema.exports.find((e:any)=>e.name==='process').cName}(context,before,instruction)`;
const rootDecl=`${token4.schema.types.find((t:any)=>t.name==='Outcome').cType} outcome=${rootCall};`;
add('root invoked twice','token-4',token4.adapter,once(c4,rootDecl,`${rootDecl}\n  outcome=${rootCall};`,'root-twice'),
    'semantic','root-context-before-instruction');
const ixDecode=`if(!${ident(token4.interface.instruction)}_decode(ix+1,${token4.interface.instructionBytes-1},&instruction)) return 2;`;
add('root before instruction decode','token-4',token4.adapter,
  once(once(c4,ixDecode,'','ix-decode'),rootDecl,`${rootDecl}\n  ${ixDecode}`,'root-order'),'semantic','uninitialized');
const earlyTarget=`const u8 header0[20]={${tokenFields[0].header.join(',')}};`;
add('early commit before all field validation','token-4',token4.adapter,
  once(c4,earlyTarget,`${earlyTarget}\n  __builtin_memcpy(state0.data,header0,20);`,'early-commit'),'semantic','no-adapter-writes-on-explicit-failure');
const missingPayload=`__builtin_memcpy(state3.data+${20+tokenFields[3].bindingBytes},encoded3,${tokenFields[3].stateBytes-20-tokenFields[3].bindingBytes});`;
add('missing final field commit','token-4',token4.adapter,once(c4,missingPayload,'','missing-commit'),
    'semantic','exact-per-account-header-binding-payload-and-reply');

function loopLine(c:string,kind:'validate'|'execute') {
  const pattern=kind==='validate'?/  for\(unsigned i=0;i<\d+;\+\+i\) \{ u64 error=[^\n]*_validate[^\n]*\n/:/  for\(unsigned i=0;i<\d+;\+\+i\) if\(bend_\w+_execute[^\n]*\n/;
  const found=c.match(pattern); assert(found,`${kind} loop not found`); assert.equal(c.match(new RegExp(pattern.source,'g'))?.length,1,`${kind} loop ambiguous`); return found[0];
}
const validateLoop=loopLine(c4,'validate'), executeLoop=loopLine(c4,'execute');
add('execute effects before validating all slots','token-4',token4.adapter,
  once(once(c4,validateLoop,'@@EXEC@@','validate-loop'),executeLoop,validateLoop,'execute-loop').replace('@@EXEC@@',executeLoop),
  'semantic','all-encodes-validation-execution-before-commit');
const extractLine=`if(!bend_extract_effects(&outcome.as.c0.f1,transfers)) return 9;`;
add('validate effects before extraction','token-4',token4.adapter,
  once(once(c4,extractLine,'','extract-first'),validateLoop,`${validateLoop}${extractLine}\n`,'validate-first'),
  'semantic','uninitialized');
add('root rejection code width changed','token-4',token4.adapter,
  once(c4,'0xfffffeffu','0xfffffffeu','reject-width'),'semantic','ordered-return-contract');

// ABI2 CPI guard: validation's helper error must win over code 22. The scan
// includes all managed indices, including a second writable meta (j=1).
const cpi4=byName('cpi-4'), cpiC=cpi4.files[cpi4.adapter];
const validationError='if(error) return error;';
const cpiGuardStart=cpiC.indexOf('if(transfers[i].active)');
assert(cpiGuardStart>=0,'CPI managed-state guard not found');
const cpiGuardEnd=cpiC.indexOf('return 22;',cpiGuardStart)+ 'return 22;'.length;
const guardText=cpiC.slice(cpiGuardStart,cpiGuardEnd);
add('unbounded CPI error-order scan fails on meta bounds','cpi-4',cpi4.adapter,
  once(cpiC,`${validationError} ${guardText}`,`${guardText} ${validationError}`,'cpi-unbounded-precedence'),
  'semantic','bounds: metas[8] outside 8 elements');
const boundedGuardText=guardText.replace('j<transfers[i].count;++j','j<transfers[i].count && j<8;++j');
assert.notEqual(boundedGuardText,guardText,'CPI bounded precedence probe did not add a meta bound');
add('CPI helper error must precede writable-state error 22','cpi-4',cpi4.adapter,
  once(cpiC,`${validationError} ${guardText}`,`${boundedGuardText} ${validationError}`,'cpi-precedence'),
  'semantic','ordered-return-contract');
const secondMetaCondition='j<transfers[i].count';
add('CPI second meta writable-managed guard omitted','cpi-4',cpi4.adapter,
  once(cpiC,secondMetaCondition,'j<transfers[i].count && j<1','second-meta'),'semantic','ordered-return-contract');
const omittedState= cpi4.interface.stateAccounts.at(-1).index;
const stateGuard=`transfers[i].metas[j].index==${omittedState}`;
add('CPI final managed account excluded from writable guard','cpi-4',cpi4.adapter,
  once(cpiC,` || ${stateGuard}`,'','managed-state-guard'),'semantic','ordered-return-contract');

// Dependency, duplicate and decoy-binding negatives. Every case is reparsed
// from mutated written C/header text; no source-level template is substituted.
const token2=byName('token-2');
add('token helper overload','token-2','token.h',
  token2.files['token.h']+'\nstatic inline u64 bend_custody(void) { return 0; }\n','grammar','ambiguous file-scope binding');
for (const name of ['bend_transfer_validate','bend_transfer_execute'])
  add(`token ${name} overload`,'token-2','token.h',
    token2.files['token.h']+`\nstatic inline u64 ${name}(void) { return 0; }\n`,'grammar','ambiguous file-scope binding');
add('adapter macro decoy binding','token-2','token.h',
  token2.files['token.h'].replace('#pragma once','#pragma once\n#define bend_custody 7'),'grammar','macro');
const cpi2=byName('cpi-2');
add('CPI custody helper overload','cpi-2','bend_cpi.h',
  cpi2.files['bend_cpi.h']+'\nstatic inline u64 bend_invoke_custody(void) { return 0; }\n','grammar','ambiguous file-scope binding');
for (const name of ['bend_invoke_validate','bend_invoke_execute'])
  add(`CPI ${name} overload`,'cpi-2','bend_cpi.h',
    cpi2.files['bend_cpi.h']+`\nstatic inline u64 ${name}(void) { return 0; }\n`,'grammar','ambiguous file-scope binding');
add('runtime read_le overload','token-2','solana_min.h',
  token2.files['solana_min.h']+'\nstatic inline u64 read_le(void) { return 0; }\n','grammar','ambiguous file-scope binding');
const extractStart=c4.indexOf('static inline int bend_extract_effect(');
assert(extractStart>=0,'token extraction definition missing');
let depth=0, extractEnd=-1, opened=false;
for(let i=extractStart;i<c4.length;i++) { if(c4[i]==='{') {depth++;opened=true;} else if(c4[i]==='}') {depth--;if(opened&&depth===0){extractEnd=i+1;break;}} }
assert(extractEnd>extractStart,'token extraction body unmatched');
const duplicateExtraction=c4.slice(extractStart,extractEnd);
add('duplicate extraction helper definition','token-4',token4.adapter,
  once(c4,'typedef struct { u64 slot;',`${duplicateExtraction}\ntypedef struct { u64 slot;`,'duplicate-extraction'),
  'grammar','extraction function declared again');
add('duplicate entrypoint binding','pure-2',byName('pure-2').adapter,
  byName('pure-2').files[byName('pure-2').adapter]+'\nu64 entrypoint(const u8 *input) { return 0; }\n',
  'grammar','text after entrypoint');
// An identifier-rich macro replacement and a comment decoy cannot supply a
// missing helper definition; the helper overload case above checks uniqueness.
const custody=token2.files['token.h'];
const fnStart=custody.indexOf('static inline u64 bend_custody('); assert(fnStart>=0);
let brace=0, fnEnd=-1, fnOpened=false;
for(let i=fnStart;i<custody.length;i++){if(custody[i]==='{'){brace++;fnOpened=true;}else if(custody[i]==='}'){brace--;if(fnOpened&&brace===0){fnEnd=i+1;break;}}}
assert(fnEnd>fnStart);
const missingCustody=custody.slice(0,fnStart)+`/* ${custody.slice(fnStart,fnEnd)} */`+custody.slice(fnEnd);
add('comment decoy cannot bind missing custody helper','token-2','token.h',missingCustody,'grammar','ambiguous file-scope binding');

// Whitespace and a lexical comment decoy are equivalent source-text variants,
// each still parsed, symbolically executed and checked against all claims.
for (const f of fixtures.slice(0,3)) {
  const c=f.files[f.adapter];
  const changed=c.replace('u64 count = read_le(input,8);','u64 count=read_le(input,8);\n  /* entrypoint bend_process read_account is only a comment decoy. */');
  assert.notEqual(changed,c,`${f.name}: equivalent variant did not alter written C`);
  equivalents.push({name:'comment decoy and whitespace equivalent',fixture:f.name,files:{[f.adapter]:changed}});
}

// Regressions for review-confirmed false greens: success must be interpreted
// under the path condition, replies must have exact length, and helper arguments
// must carry the validated invocation count and custody output unchanged.
for (const name of ['pure-2','cpi-4']) {
  const f=byName(name), c=f.files[f.adapter];
  const call=c.match(/sol_set_return_data\(reply,(\d+)\)/)!; assert(call);
  add('truncated successful reply',name,f.adapter,
    once(c,call[0],`sol_set_return_data(reply,${Number(call[1])-1})`,'reply length'),
    'semantic','exact-per-account-header-binding-payload-and-reply');
}
const pure2=byName('pure-2'), pureC=pure2.files[pure2.adapter];
const pureTail=pureC.match(/sol_set_return_data\(reply,\d+\); return 0;/)![0];
const noCommits=pureC.replace(/^  __builtin_memcpy\([^\n]*\n/gm,'');
assert.notEqual(noCommits,pureC);
add('no commits with path-constrained zero return','pure-2',pure2.adapter,
  once(noCommits,pureTail,'return state0.executable;','symbolic zero'),
  'semantic','all-encodes-validation-execution-before-commit');
const lastPayload='__builtin_memcpy(state3.data+52,encoded3,5);';
add('last commit omitted with custody success return','cpi-4',cpi4.adapter,
  once(once(cpiC,lastPayload,'','last commit'), 'return 0;\n}', 'return setup;\n}', 'custody success return'),
  'semantic','all-encodes-validation-execution-before-commit');
for (const [name,helper] of [['token-4','bend_transfer'],['cpi-4','bend_invoke']]) {
  const f=byName(name),c=f.files[f.adapter];
  for (const operation of ['validate','execute']) {
    const call=`${helper}_${operation}(&transfers[i],accounts,(unsigned)count${operation==='execute'?',bump':''})`;
    add(`${operation} account count truncated`,name,f.adapter,
      once(c,call,call.replace('(unsigned)count','7'),'helper count'),'semantic','helper:');
  }
  const call=`${helper}_execute(&transfers[i],accounts,(unsigned)count,bump)`;
  add('execution uses constant custody bump',name,f.adapter,
    once(c,call,call.replace(',bump)',',0)'),'helper bump'),'semantic','helper:');
}
equivalents.push({name:'success returned through validated zero flag',fixture:'pure-2',
  files:{[pure2.adapter]:once(pureC,pureTail,pureTail.replace('return 0;','return state0.executable;'),'equivalent zero')}});
equivalents.push({name:'success returned through custody result',fixture:'cpi-4',
  files:{[cpi4.adapter]:once(cpiC,'return 0;\n}','return setup;\n}','equivalent custody')}});

// Both small and outlined instruction decoders remain exactly signature-bound.
for (const id of ['pure-2', 'cpi-4']) {
  const f = byName(id), wire = `${id}.wire.h`;
  const root = f.schema.exports.find((e:any)=>e.name===f.interface.root)!;
  const name = ident(root.args[2]) + '_decode';
  const outlined = `static __attribute__((noinline)) inline int ${name}(`;
  const inline = `static inline int ${name}(`;
  const text = f.files[wire];
  add('codec annotation: wrong instruction decoder storage',id,wire,
    text.includes(outlined) ? once(text,outlined,inline,name) : once(text,inline,outlined,name),
    'grammar',`dependencies: ${name} signature`);
}

const payload={coverage:selections.map(x=>x[0]).sort(),fixtures,mutations,equivalents,immutableInputs};
immutableInputs[path.resolve(import.meta.path)] = sha(import.meta.path);
payload.immutableInputs = immutableInputs;
fs.writeFileSync(payloadPath,JSON.stringify(payload));
for (const [file,digest] of Object.entries(immutableInputs)) assert.equal(sha(file),digest,`input changed before Python check: ${file}`);
prepareBend();
const python=spawnSync(process.env.PYTHON??'python3',[
  '-B','verification/multi_adapter_contract.py',payloadPath,pythonOutput],
  {cwd:root,encoding:'utf8',timeout:1_800_000,maxBuffer:100*1024*1024});
assert.ifError(python.error);
if (python.status!==0) throw new Error([python.stdout,python.stderr].filter(Boolean).join('\n')||`Python checker exited ${python.status}`);
process.stdout.write(python.stdout);
const report=JSON.parse(fs.readFileSync(pythonOutput,'utf8'));
assert.equal(report.passed,true);
assert.equal(report.totals.fixtures,9);
assert.equal(report.totals.unsatClaims,report.totals.claims);
assert.equal(report.totals.mutations,mutations.length);
assert.equal(report.totals.equivalentVariants,equivalents.length);
for (const [file,digest] of Object.entries(immutableInputs)) assert.equal(sha(file),digest,`source/artifact changed before publication: ${file}`);
fs.renameSync(pythonOutput,reportPath);
console.log(`Published ABI2 multi-state symbolic assurance report: ${reportPath}`);
