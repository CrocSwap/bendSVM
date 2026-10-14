import sys,pathlib,json,hashlib,random,subprocess,os
sys.path.insert(0,'verification')
from acyclic_c import Source,wire
from codec_semantics import Codecs,need
import z3 as z
receipt=json.loads(pathlib.Path('build/vault-adapter-bridge/fresh-receipt.json').read_text());root=pathlib.Path(receipt['input']).parent;raw=pathlib.Path(receipt['input']).read_bytes();data=json.loads(raw);f=data['fixture'];source=Source(data['program']['source']);rng=random.Random(73481)
codecs=Codecs(source,{'name':'vault','headerName':'vault.h','schema':f['schema'],'native':f['files']['vault.h'],'codecs':f['files']['vault.wire.h']})
for name in ['vault.h','vault.wire.h']:(root/name).write_text(f['files'][name])
def value(name):
 t=codecs.types[name]
 if t['kind']=='bool':return z.BoolVal(bool(rng.randrange(2)))
 if t['kind']=='u32':return z.BitVecVal(rng.randrange(t.get('max',2**32-1)+1),32)
 i=rng.randrange(len(t['variants']));return source.sort(name).constructor(i)(*[value(x['type']) for x in t['variants'][i]['fields']])
def literal(name,v):
 t=codecs.types[name]
 if t['kind']=='bool':return '1u' if v else '0u'
 if t['kind']=='u32':return str(v)+'u'
 variant=next(x for x in t['variants'] if x['name']==v['constructor']);return variant['cMaker']+'('+','.join(literal(x['type'],v['fields'][x['name']]) for x in variant['fields'])+')'
def equality(name,v,expr):
 t=codecs.types[name]
 if t['kind']!='adt':return f'({expr})=={literal(name,v)}'
 variant=next(x for x in t['variants'] if x['name']==v['constructor']);tag=variant['tag'];parts=[f'({expr}).tag=={tag}u']
 parts.extend(equality(x['type'],v['fields'][x['name']],f'({expr}).as.c{tag}.f{i}') for i,x in enumerate(variant['fields']))
 return '('+' && '.join(parts)+')'
lines=['#include "vault.wire.h"','#include <stdio.h>','#include <string.h>','int main(void) {'];cases=[]
for name in codecs.order:
 t=codecs.types[name];ctype=t['cType'];n=codecs.sizes[name];base='bend_'+''.join(c if c.isascii() and c.isalnum() else '_'+format(ord(c),'x')+'_' for c in name)
 for i in range(6):
  v=value(name);wv=wire(source,name,z.simplify(v));ok,encoded=codecs.encode(name,v);need(z.is_true(z.simplify(ok)),'valid value rejected');bs=[z.simplify(b).as_long() for b in encoded]
  k=len(cases);lines.append('{ '+ctype+' value='+literal(name,wv)+f'; unsigned char encoded[{n}], expected[{n}]={{'+','.join(map(str,bs))+'};'+f' if(!{base}_encode(encoded,{n},&value)||memcmp(encoded,expected,{n})) {{printf("encode case {k} failed\\n");return 1;}} '+'}');cases.append({'kind':'encode','type':name})
  flip=rng.randrange(n)
  variants=[bs,[(b^1) if j==flip else b for j,b in enumerate(bs)],[rng.randrange(256) for _ in range(n)]]
  for bytes_ in variants:
   ok,decoded=codecs.decode(name,[z.BitVecVal(b,8) for b in bytes_]);expected=z.is_true(z.simplify(ok));k=len(cases)
   check=equality(name,wire(source,name,z.simplify(decoded)),'value') if expected else '1'
   lines.append('{ '+ctype+f' value; unsigned char bytes[{n}]={{'+','.join(map(str,bytes_))+'};'+f' int ok={base}_decode(bytes,{n},&value); if(ok!={int(expected)} || (ok && !({check}))) {{printf("decode case {k} failed\\n");return 1;}} '+'}');cases.append({'kind':'decode','type':name,'expected':expected})
lines.extend(['return 0;','}']);c=root/'native.c';c.write_text('\n'.join(lines)+'\n');exe=root/'native.out'
compile_=subprocess.run(['clang','-std=c11','-O1','-fsanitize=undefined','-fno-sanitize-recover=all',str(c),'-o',str(exe)],capture_output=True,text=True,timeout=60);(root/'compile.log').write_text(compile_.stdout+compile_.stderr);need(compile_.returncode==0,compile_.stderr)
run=subprocess.run([str(exe)],capture_output=True,text=True,timeout=10);need(run.returncode==0,run.stdout+run.stderr)
for p,h in {**data['sourceHashes'],**data['artifactHashes']}.items():need(hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()==h,p)
report={'passed':True,'cases':cases,'inputSha256':hashlib.sha256(raw).hexdigest(),'checkerSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'semanticsSha256':hashlib.sha256(pathlib.Path('verification/codec_semantics.py').read_bytes()).hexdigest(),'cSha256':hashlib.sha256(c.read_bytes()).hexdigest(),'sanitizer':'undefined','scope':'Finite actual native emitted-codec comparison with the symbolic value/byte model.'};(root/'native-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'cases':len(cases)}))
