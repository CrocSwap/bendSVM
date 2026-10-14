import sys,pathlib,json,hashlib,random,subprocess,os,re
sys.path.insert(0,'verification')
import z3 as z
from acyclic_c import Source,need
from effect_semantics import Extraction
import effect_extraction as e
fresh=json.loads(pathlib.Path('build/vault-adapter-bridge/fresh-receipt.json').read_text());p=pathlib.Path(fresh['input']);raw=p.read_bytes();data=json.loads(raw);f=data['fixture'];src=Source(data['program']['source']);model=Extraction(src,f);spec=model.spec;outputs=model.outputs;plural_outputs=model.slots;plural_value=model.plural_value
for file,h in {**data['sourceHashes'],**data['artifactHashes']}.items():need(hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()==h,'input drift '+file)
from acyclic_c import wire
root=p.parent/'effect-native';root.mkdir(exist_ok=True);rng=random.Random(91341);types={t['name']:t for t in f['schema']['types']}
def sample(name):
 t=types[name]
 if t['kind']=='u32':return z.BitVecVal(rng.choice([0,1,2**32-1,rng.randrange(2**32)]),32)
 if t['kind']=='bool':return z.BoolVal(bool(rng.randrange(2)))
 k=rng.randrange(len(t['variants']));return src.sort(name).constructor(k)(*[sample(field['type']) for field in t['variants'][k]['fields']])
def literal(name,v):
 t=types[name]
 if t['kind']=='u32':return str(v)+'u'
 if t['kind']=='bool':return '1u' if v else '0u'
 variant=next(x for x in t['variants'] if x['name']==v['constructor']);return variant['cMaker']+'('+','.join(literal(x['type'],v['fields'][x['name']]) for x in variant['fields'])+')'
def location(loc):
 if isinstance(loc[0],tuple):return '.'.join(str(x) for x in loc[0])+'['+str(loc[1])+']'
 need(len(loc)==1,'native location unsupported');return loc[0]
for name,contents in f['files'].items():
 if name!=f['adapter']:(root/name).write_text(contents)
marker='typedef struct { u64 slot;';adapter=f['files'][f['adapter']];need(adapter.count(marker)==1,'extraction prefix boundary');head=adapter.split(marker)[0]
lines=[head,'#include <stdio.h>','int main(void) {'];cases=[]
for i in range(48):
 v=sample(spec.effects);wv=wire(src,spec.effects,z.simplify(v));checks=[]
 for j,slot in enumerate(plural_outputs):
  for loc,expr in slot.items():
   expected=z.simplify(z.substitute(expr,(plural_value,v))).as_long();checks.append(f'out[{j}].{location(loc)} == {expected}ull')
 lines.append('{ '+spec.effects_ctype+' value='+literal(spec.effects,wv)+'; '+spec.slot_type+f' out[{spec.slots}]; if(!bend_extract_effects(&value,out) || !('+' && '.join(checks)+f')) {{printf("case {i} failed\\n");return 1;}} }}');cases.append(wv)
lines+=['return 0;','}'];c=root/'test.c';c.write_text('\n'.join(lines));exe=root/'test.out'
compile_=subprocess.run([os.environ.get('CC','clang'),'-std=c11','-O1','-fsanitize=undefined','-fno-sanitize-recover=all',str(c),'-o',str(exe)],capture_output=True,text=True,timeout=60);(root/'compile.log').write_text(compile_.stdout+compile_.stderr);need(compile_.returncode==0,compile_.stderr)
run=subprocess.run([str(exe)],capture_output=True,text=True,timeout=10);need(run.returncode==0,run.stdout+run.stderr)
report={'passed':True,'cases':len(cases),'fieldsPerCase':len(outputs)*spec.slots,'inputSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'cSha256':hashlib.sha256(c.read_bytes()).hexdigest(),'checkerSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'sanitizer':'undefined','scope':'Finite comparison of actual emitted extraction C with typed symbolic plural extraction.'}
# Deliberately wrong symbolic amount must fail against actual extraction C.
text=c.read_text();matches=list(re.finditer(r'out\[0\]\.amount == (\d+)ull',text));selected=next(m for m in matches if (int(m[1])&0xffffffff)!=(int(m[1])>>32));v=int(selected[1]);wrong=((v&0xffffffff)<<32)|(v>>32)
fault=root/'swapped-model.c';fault.write_text(text[:selected.start(1)]+str(wrong)+text[selected.end(1):]);badexe=root/'swapped-model.out'
compiled=subprocess.run([os.environ.get('CC','clang'),'-std=c11','-O1','-fsanitize=undefined','-fno-sanitize-recover=all',str(fault),'-o',str(badexe)],capture_output=True,text=True,timeout=60);need(compiled.returncode==0,compiled.stderr)
bad=subprocess.run([str(badexe)],capture_output=True,text=True,timeout=10);need(bad.returncode==1 and re.fullmatch(r'case \d+ failed\n',bad.stdout),'native sensitivity failed')
report['negative']={'exitCode':bad.returncode,'mismatch':bad.stdout.strip(),'cSha256':hashlib.sha256(fault.read_bytes()).hexdigest()}
for file,h in {**data['sourceHashes'],**data['artifactHashes']}.items():need(hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()==h,'input drift '+file)
(p.parent/'effect-native-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
