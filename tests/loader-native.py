from pathlib import Path
import json,hashlib,subprocess,shutil,uuid,sys
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
from loader_report import validate,unchanged
root=Path('build/loader');receipt=json.loads((root/'fresh-receipt.json').read_bytes());sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
assert sha(receipt['inputArtifact'])==receipt['inputSha256'] and sha(receipt['reportArtifact'])==receipt['reportSha256']
raw=Path(receipt['inputArtifact']).read_bytes();data=json.loads(raw);validate(json.loads(Path(receipt['reportArtifact']).read_bytes()),data,raw);unchanged(data)
source=Path(data['headerArtifact']);original=source.read_text();run=root/('qualified-native-'+str(uuid.uuid4()));run.mkdir();compiler=shutil.which('clang');assert compiler
harness=Path('tests/loader-native.h');before={str(p):sha(p) for p in [Path(__file__),harness]};rows=[]
for name,old,new,reason in [('baseline',None,None,''),('owner-offset','a->owner = p + 40;','a->owner = p + 41;','field pointer mismatch'),
 ('flag-mask','a->signer = p[1] != 0;','a->signer = p[1] & 1;','flag mismatch'),
 ('alignment','(next + 7) & ~(u64)7','next & ~(u64)7','successor mismatch'),
 ('duplicate-marker','if (p[0] != 255)','if (p[0] == 0)','duplicate accepted')]:
 d=run/name;d.mkdir();text=original
 if old:assert text.count(old)==1;text=text.replace(old,new)
 (d/'solana_min.h').write_text(text);shutil.copy2(harness,d/'main.c');exe=d/'run'
 r=subprocess.run([compiler,'-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all',str(d/'main.c'),'-o',str(exe)],capture_output=True,text=True,timeout=60)
 (d/'compile.log').write_text(r.stdout+r.stderr);assert r.returncode==0,r.stderr
 r=subprocess.run([str(exe)],capture_output=True,text=True,timeout=60);(d/'run.log').write_text(r.stdout+r.stderr)
 assert r.returncode==(42 if old else 0),(name,r)
 assert reason in r.stderr if old else r.stdout=='1239 decoder cases passed\n' and not r.stderr
 rows.append({'name':name,'exitCode':r.returncode,'files':{str(p):sha(p) for p in d.iterdir() if p.is_file()}})
unchanged(data);assert {p:sha(p) for p in before}==before
assert sha(receipt['inputArtifact'])==receipt['inputSha256'] and sha(receipt['reportArtifact'])==receipt['reportSha256']
report={'passed':True,'inputSha256':receipt['inputSha256'],'reportSha256':receipt['reportSha256'],'headerSha256':sha(source),'testSources':before,'cases':1239,'compiler':compiler,'compilerSha256':sha(compiler),'replays':rows,
 'scope':'Actual qualified C header, valid aligned contiguous buffers and two-account cursor chains; native objects disjoint. No VM region mapping or SBF preservation.'}
(run/'report.json').write_text(json.dumps(report,indent=2)+'\n');Path(sys.argv[1]).open('x').write(json.dumps({'passed':True,'inputSha256':receipt['inputSha256'],'reportSha256':receipt['reportSha256'],'artifact':str(run/'report.json'),'sha256':sha(run/'report.json')},indent=2)+'\n');print(run);print('Qualified header: 1239 native cases and four faults passed')
