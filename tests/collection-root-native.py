from pathlib import Path
import json,hashlib,subprocess,shutil,uuid
import os,sys
if not __debug__:raise RuntimeError('collection native assertions required')
sys.path.insert(0,'verification')
from collection_root_report import unchanged,validate
input_path=Path(sys.argv[1]);report_path=Path(sys.argv[2]);output=Path(sys.argv[3]);assert not output.exists()
raw=input_path.read_bytes();data=json.loads(raw);report_raw=report_path.read_bytes();validate(json.loads(report_raw),data,raw);unchanged(data)
files=data['caller']['artifactPaths'];original=Path(files['collection-store.c']).read_text();sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
runroot=input_path.parent/'native-caller-runs'/str(uuid.uuid4());runroot.mkdir(parents=True)
harness=Path('tests/collection-root-native.h')

variants=[('baseline',original,0,''),('wrong-state-byte',original.replace('__builtin_memcpy(state->data+20,encoded_state,5);','__builtin_memcpy(state->data+20,encoded_state,5);state->data[21]^=1;'),42,'state bytes mismatch'),('wrong-record-byte',original.replace('  bend_collection_commit(', '  encoded_records[0]^=1;\n  bend_collection_commit('),42,'collection bytes mismatch'),('early-state-write',original.replace('  BendCollectionWindow selected;', '  state->data[24]^=1;\n  BendCollectionWindow selected;'),42,'refusal changed account bytes')]
compiler=shutil.which(os.environ.get('CC','clang'));assert compiler;rows=[]
for name,c,wanted,reason in variants:
 if name!='baseline':assert c!=original
 d=runroot/name;d.mkdir()
 for n in ['collection-store.h','collection-store.wire.h']:shutil.copy2(files[n],d/n)
 for n in ['bend_collection_runtime.h','solana_min.h']:shutil.copy2(Path('runtime')/n,d/n)
 (d/'collection-store.c').write_text(c);shutil.copy2(harness,d/'main.c');exe=d/'run'
 result=subprocess.run([compiler,'-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all',str(d/'main.c'),'-o',str(exe)],capture_output=True,text=True,timeout=60);(d/'compile.log').write_text(result.stdout+result.stderr);assert result.returncode==0,result.stderr
 result=subprocess.run([str(exe)],capture_output=True,text=True,timeout=30);(d/'run.log').write_text(result.stdout+result.stderr);assert result.returncode==wanted,(name,result)
 assert reason in result.stderr if reason else result.stderr==''
 if name=='baseline':assert result.stdout=='160 caller cases passed\n',result.stdout
 rows.append({'name':name,'exitCode':result.returncode,'files':{str(p):sha(p) for p in d.iterdir() if p.is_file()}})
unchanged(data);assert input_path.read_bytes()==raw and report_path.read_bytes()==report_raw
with output.open('x') as stream:stream.write(json.dumps({'passed':True,'cases':160,'inputSha256':hashlib.sha256(raw).hexdigest(),
 'reportSha256':hashlib.sha256(report_raw).hexdigest(),'checkerSha256':sha(__file__),'compiler':compiler,'compilerSha256':sha(compiler),
 'harnessSha256':sha(harness),'replays':rows,
 'scope':'Actual generated bend_collection_run and runtime helpers with valid Account objects. Bypasses serialized entrypoint loader, stubs clock/return syscalls; no SBF or rollback theorem.'},indent=2)+'\n')
print('160 caller cases and three native faults passed')
