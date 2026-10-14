if not __debug__:raise RuntimeError('memory proof assertions required')
from pathlib import Path
import os
OUT=Path(os.environ.get("MEMORY_RUN_DIR","build/collection-memory"))
import subprocess,shutil,hashlib,json,uuid
root=OUT;run=root/('native-commit' if os.environ.get('MEMORY_INPUT') else 'native-'+str(uuid.uuid4()));run.mkdir();sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest();compiler=json.loads(Path(os.environ['MEMORY_INPUT']).read_bytes())['compiler']['path'] if os.environ.get('MEMORY_INPUT') else shutil.which(os.environ.get('CC','clang'));rows=[]
headers={n:Path('runtime',n).read_text() for n in ['solana_min.h','bend_collection_runtime.h']}
faults=[('baseline',None,None,None),('record-offset','data[offset + i] = encoded[i]','data[offset + i + 1] = encoded[i]','whole serialized buffer mismatch'),('key-source','data[24 + i] = state_key[i]','data[24 + i] = state_key[(i + 1) % 32]','whole serialized buffer mismatch'),('metadata-clobber','c->length = next_length;','data[-1] ^= 1; c->length = next_length;','whole serialized buffer mismatch'),('descriptor-clobber','c->length = next_length;','c->capacity = 0; c->length = next_length;','collection descriptor mismatch')]
for name,old,new,reason in faults:
 out=run/name;out.mkdir();text=headers['bend_collection_runtime.h']
 if old:assert text.count(old)==1;text=text.replace(old,new)
 (out/'bend_collection_runtime.h').write_text(text);(out/'solana_min.h').write_text(headers['solana_min.h']);shutil.copy2(Path('tests/collection-memory-native.h'),out/'main.c')
 c=subprocess.run([compiler,'-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all',str(out/'main.c'),'-o',str(out/'run')],capture_output=True,text=True,timeout=60);(out/'compile.log').write_text(c.stdout+c.stderr);assert c.returncode==0,c.stderr
 r=subprocess.run([str(out/'run')],capture_output=True,text=True,timeout=60);(out/'run.log').write_text(r.stdout+r.stderr)
 assert r.returncode==(42 if old else 0),(name,r)
 if old:assert r.stderr==reason+'\n',(name,r.stderr)
 else:assert r.stdout.endswith(' whole-buffer commit cases passed\n') and not r.stderr;cases=int(r.stdout.split()[0]);assert cases==771,'native case inventory'
 rows.append({'name':name,'exitCode':r.returncode,'files':{str(p):sha(p) for p in out.iterdir()}})
for n,text in headers.items():assert Path('runtime',n).read_text()==text
report={'passed':True,'cases':cases,'compiler':compiler,'compilerSha256':sha(compiler),'headerHashes':{n:hashlib.sha256(t.encode()).hexdigest() for n,t in headers.items()},'replays':rows,'scope':'Actual loader and commit helper in a contiguous serialized buffer, sanitizer baseline and four deliberate faults. Enumerated valid small windows plus boundary allocations up to10MiB; not full adapter or SBF execution.'}
(run/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(run);print(cases,'cases and four faults passed')
