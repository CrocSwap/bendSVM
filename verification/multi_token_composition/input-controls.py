from pathlib import Path
import copy,hashlib,json,sys,uuid
sys.path.insert(0,'verification')
from multi_token_composition.common import begin
from multi_token_composition.model import analyse_fixture
if len(sys.argv)!=2:raise ValueError('usage: input-controls.py QUALIFIED_RUN')
source=Path(sys.argv[1]).resolve();original=source/'fixtures/input.json';data=json.loads(original.read_text())
root=source.parent/('input-controls-'+str(uuid.uuid4()));root.mkdir()
rows=[]
def run(name,change,expected):
 value=copy.deepcopy(data);change(value);inp=root/(name+'.json');out=root/(name+'-report.json');inp.write_text(json.dumps(value)+'\n')
 try:begin(inp,out)
 except ValueError as error:
  assert expected in str(error),(name,str(error));assert not out.exists();rows.append({'name':name,'reason':str(error)})
 else:raise RuntimeError('accepted '+name)
run('missing-fixture',lambda d:d['fixtures'].pop(),'exact fixture inventory')
run('native-header-mismatch',lambda d:d['fixtures'][0]['program']['artifact'].__setitem__('c','wrong'),'included native header binding')
run('source-root-mismatch',lambda d:d['fixtures'][0]['program']['source'].__setitem__('roots',['wrong']),'source root binding')
run('source-schema-mismatch',lambda d:d['fixtures'][0]['program']['source'].__setitem__('schema',{}),'source/native schema binding')
run('native-digest-mismatch',lambda d:d['fixtures'][0]['program']['artifact'].__setitem__('cSha256','0'*64),'native header digest')
run('missing-artifact-path',lambda d:d['fixtures'][0]['artifactPaths'].pop('token-2.h'),'exact artifact path inventory')
run('unbound-source',lambda d:d['fixtures'][0]['sourceDependencies'].__setitem__(d['fixtures'][0]['source'],'0'*64),'source dependency binding')
try:analyse_fixture({},witness=[{'name':'fake','value':'0'}])
except ValueError as error:
 assert str(error)=='positive composition must be unpinned';rows.append({'name':'positive-pins','reason':str(error)})
else:raise RuntimeError('positive accepted pins')
for fault,witness in [('unknown',[{'name':'fake','value':'0'}]),('managed-byte',None)]:
 try:analyse_fixture({},fault=fault,witness=witness)
 except ValueError as error:
  assert str(error)=='fault control requires named mutation and positive witness';rows.append({'name':'invalid-fault-'+fault,'reason':str(error)})
 else:raise RuntimeError('invalid control accepted')
same=root/'same.json';same.write_text('preserve');before=same.read_bytes()
try:begin(same,same)
except ValueError as error:
 assert str(error)=='input/output paths must differ' and same.read_bytes()==before;rows.append({'name':'same-input-output','reason':str(error)})
else:raise RuntimeError('input/output alias accepted')
inputs=[Path(__file__),original,*Path('verification/multi_token_composition').glob('*.py')]
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'controls':rows,'inputHashes':{str(p.resolve()):sha(p) for p in inputs},'sourceRun':str(source),'sourceAcceptedSha256':sha(source/'accepted.json'),'scope':'Input binding and positive/control API refusals. These tests do not qualify the full gate.'}
(root/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(str(root/'report.json'))
