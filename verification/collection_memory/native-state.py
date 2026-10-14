if not __debug__:raise RuntimeError('memory proof assertions required')
from pathlib import Path
import os
OUT=Path(os.environ.get("MEMORY_RUN_DIR","build/collection-memory"))
import sys,json,subprocess,hashlib,uuid
sys.path.insert(0,'verification/collection_entry/qualification')
import native_bundle as nb
import fresh_report
root=OUT;run=root/('native-state' if os.environ.get('MEMORY_INPUT') else 'native-state-'+str(uuid.uuid4()));run.mkdir();receipt=json.loads(Path(os.environ['MEMORY_INPUT']).read_bytes())['entryReceipt'] if os.environ.get('MEMORY_INPUT') else json.loads(Path('build/collection-entry/fresh-receipt.json').read_bytes());fresh_report.validate(receipt['beforeArtifact'],receipt['inputArtifact']);data=json.loads(Path(receipt['beforeArtifact']).read_bytes());compiler=data['nativeCompiler'];sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest();assert sha(compiler['path'])==compiler['sha256'];rows=[]
cases=[('baseline',None,None,None,''),('state-payload-offset','collection-store.c','__builtin_memcpy(state->data+20,encoded_state,5);','__builtin_memcpy(state->data+21,encoded_state,5);','state bytes mismatch'),('state-header-short','collection-store.c','__builtin_memcpy(state->data,state_header,20);','__builtin_memcpy(state->data,state_header,19);','state bytes mismatch')]
for case in cases:
 name,target,old,new,reason=case;out=run/name;out.mkdir()
 for n,t in nb.texts(data,case).items():(out/n).write_text(t)
 c=subprocess.run([compiler['path'],'-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all',str(out/'main.c'),'-o',str(out/'run')],capture_output=True,text=True,timeout=60);(out/'compile.log').write_text(c.stdout+c.stderr);assert c.returncode==0,c.stderr
 c=subprocess.run([str(out/'run')],capture_output=True,text=True,timeout=30);(out/'run.log').write_text(c.stdout+c.stderr);assert c.returncode==(42 if target else 0),(name,c)
 assert c.stderr==reason+'\n' if target else c.stdout=='171 caller cases passed\n' and not c.stderr
 rows.append({'name':name,'exitCode':c.returncode,'files':{str(p):sha(p) for p in out.iterdir()}})
fresh_report.validate(receipt['beforeArtifact'],receipt['inputArtifact']);(run/'report.json').write_text(json.dumps({'passed':True,'cases':171,'entryReceipt':receipt,'compiler':compiler,'replays':rows,'scope':'Same qualified serialized generated entrypoint and native harness, with two generated-state-copy mutations. Native sanitizer evidence, not SBF preservation.'},indent=2)+'\n');print(run);print('171 entry cases and two state-copy faults passed')
