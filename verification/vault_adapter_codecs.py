import os
import copy,hashlib,json,pathlib,subprocess,sys
sys.path.insert(0,'verification')
from codec_structures import validate,Rejected
root=pathlib.Path(os.environ.get('BRIDGE_DIR','build/vault-adapter-bridge'))
def need(value,message):
    if not value: raise RuntimeError(message)
def sha(path):return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
data=json.loads((root/'input.json').read_text());fixture=data['fixture']
bindings={**data['sourceHashes'],**data['artifactHashes']}
def bound():
    for path,h in bindings.items():need(sha(path)==h,'changed input: '+path)
bound()
bundle={'name':'vault','headerName':'vault.h','schema':fixture['schema'],'native':fixture['files']['vault.h'],'codecs':fixture['files']['vault.wire.h']}
need(bundle['native']==data['program']['artifact']['c'],'native header mismatch')
# Fresh base proof in an isolated output directory; no writes to the running main suite.
base=root/'primitive-base';(base/'verification').mkdir(parents=True,exist_ok=True);(base/'build').mkdir(exist_ok=True)
driver=pathlib.Path('verification/check-codec-primitives.ts').read_text()
start='const expected = `';need(driver.count(start)==1,'primitive template anchor')
template=driver.split(start,1)[1].split('`;',1)[0]
need('${' not in template and '\\' not in template,'unexpected template interpolation/escape')
(base/'build/codec-primitives.wire.h').write_text(template)
(base/'verification/codec_primitives.py').write_bytes(pathlib.Path('verification/codec_primitives.py').read_bytes())
run=subprocess.run([sys.executable,'-B',str(base/'verification/codec_primitives.py')],capture_output=True,text=True,timeout=60)
need(run.returncode==0,run.stderr or run.stdout)
primitive=json.loads((base/'build/codec-primitives-refinement.json').read_text())
need(primitive['z3']=='5.1.0','solver pin')
need([c['result'] for c in primitive['claims']]==['unsat','unsat','unsat','sat','unsat','sat','unsat','sat'],'primitive inventory')
# Require literal primitive function bodies in this artifact to match the reviewed base.
primitives=[]
for t in bundle['schema']['types']:
    if t['kind']=='adt':continue
    name='bend_'+t['name'];start='#define '+name+'_WIRE_SIZE '
    def block(text):
        need(text.count(start)==1,'primitive occurrence '+name)
        tail=text.split(start,1)[1];return start+tail.split('#define ',1)[0].rstrip()
    need(block(bundle['codecs'])==block(template),'primitive body mismatch '+name)
    primitives.append(t['name'])
codec=validate(bundle)
mutations=[]
for name,old,new in [('wrong-high-byte','p[3] << 24','p[2] << 24'),('noncanonical-bool','if (p[0] > 1) return 0;','if (p[0] > 2) return 0;'),('ignored-child-failure',') return 0;',') return 1;')]:
    bad=copy.deepcopy(bundle);need(old in bad['codecs'],'missing mutation '+name);bad['codecs']=bad['codecs'].replace(old,new,1)
    try:validate(bad)
    except Rejected as e:mutations.append({'name':name,'rejection':str(e)})
    else:raise RuntimeError('escaped mutation '+name)
bound()
report={'passed':True,'endToEndVerified':False,'inputSha256':sha(root/'input.json'),'bindings':bindings,'checkerSha256':sha(__file__),'structureCheckerSha256':sha('verification/codec_structures.py'),'primitiveReceiptSha256':sha(base/'build/codec-primitives-refinement.json'),'primitiveTypes':primitives,'primitive':primitive,'codec':codec,'mutations':mutations,'scope':'Same-artifact codec structure and fresh primitive-base co-validation. Conditional on valid nonoverlapping memory regions, trusted parser/schema association and C semantics. Adapter call-site memory preconditions and context construction are not discharged by this report.'}
(root/'codec-report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'passed':True,'primitiveTypes':primitives,'obligations':codec['z3Obligations'],'mutations':len(mutations)}))
