import os,copy,hashlib,importlib.util,json,pathlib,sys,uuid
if not __debug__:raise RuntimeError("report controls require assertions")
base=pathlib.Path(__file__).resolve().parents[1]/'verification';root=pathlib.Path.cwd();sys.path.insert(0,str(root/'verification'))
from native_mul32 import certify
from acyclic_c import mangle
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def load(label,file):
 spec=importlib.util.spec_from_file_location(label,base/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
model=load('native64','native_c64_ast.py');validator=load('native64_report','native_body_report.py')
receipt_path=pathlib.Path(os.environ.get('NATIVE_BODY_RECEIPT',str(root/'build/native-body-lowering/fresh-receipt.json')));receipt=json.loads(receipt_path.read_text());assert receipt['passed']
report_path=pathlib.Path(receipt['bodyReport']);assert sha(report_path)==receipt['bodyReportSha256'];run=report_path.parent;positive=json.loads(report_path.read_text())
native_path=pathlib.Path(receipt['nativeReceipt']);assert sha(native_path)==receipt['nativeReceiptSha256'];focused=json.loads(native_path.read_text())
for key in ['input','report']:assert sha(root/focused[key+'Artifact'])==focused[key+'Sha256']
data=json.loads((root/focused['inputArtifact']).read_text());proof=json.loads((root/focused['reportArtifact']).read_text())
compiler=pathlib.Path(positive['rows'][0]['command'][0])
def check(r):validator.validate(r,data,proof,positive['sourceHashes'],positive['frontendVersion'],compiler,run,model,certify,mangle,sha)
check(positive)
first=lambda r:r['rows'][0]
division=lambda r:r['rows'][1]
cases=[
 ('missing-row',lambda r:r['rows'].pop(),'fixture inventory'),
 ('duplicate-row',lambda r:r['rows'].append(copy.deepcopy(r['rows'][0])),'fixture inventory'),
 ('reordered-rows',lambda r:r['rows'].reverse(),'fixture inventory'),
 ('missing-source-inventory',lambda r:r.update(sourceHashes={}),'source inventory'),
 ('stale-source-hash',lambda r:r['sourceHashes'].update({next(iter(r['sourceHashes'])):'0'*64}),'source inventory'),
 ('unknown-result',lambda r:first(r)['nativeProof'].update(result='unknown'),'native proof'),
 ('sat-result',lambda r:first(r)['nativeProof'].update(result='sat'),'native proof'),
 ('extra-proof-field',lambda r:first(r)['nativeProof'].update(unproved=True),'native proof'),
 ('missing-certificate',lambda r:first(r).update(sourceCertificate={}),'source certificate'),
 ('missing-artifacts',lambda r:first(r).update(artifacts={}),'artifact inventory'),
 ('stale-artifact',lambda r:first(r)['artifacts'].update({next(iter(first(r)['artifacts'])):'0'*64}),'artifact binding'),
 ('wrong-target',lambda r:first(r)['command'].__setitem__(1,'--target=x86_64'),'frontend command'),
 ('wrong-version',lambda r:r.update(frontendVersion='different'),'frontend binding'),
 ('overstated-scope',lambda r:r.update(endToEndVerified=True),'scope flags'),
 ('wrong-scope',lambda r:r.update(scope='end-to-end verified'),'scope flags'),
 ('false-success',lambda r:r.update(passed=False),'scope flags'),
 ('extra-row-field',lambda r:first(r).update(extra=True),'row fields'),
 ('extra-report-field',lambda r:r.update(extra=True),'report fields'),
]
cases.extend([
 ('wrong-operation',lambda r:division(r).update(operation='mul32'),'fixture inventory'),
 ('missing-operation',lambda r:division(r).pop('operation'),'fixture inventory'),
 ('division-unknown',lambda r:division(r)['nativeProof'].update(result='unknown'),'native proof'),
 ('division-missing-safety',lambda r:division(r)['nativeProof'].update(safetyObligations=0),'native proof'),
 ('division-missing-return',lambda r:division(r)['nativeProof'].update(returns=1),'native proof'),
 ('division-wrong-operators',lambda r:division(r)['nativeProof'].update(operators=['*']),'native proof'),
 ('division-forged-certificate',lambda r:division(r)['sourceCertificate'].update(nativeBodySha256='0'*64),'source certificate'),
 ('division-wrong-target',lambda r:division(r)['command'].__setitem__(1,'--target=x86_64'),'frontend command'),
 ('division-missing-ast',lambda r:division(r).update(artifacts={}),'artifact inventory'),
])
rows=[]
for label,edit,reason in cases:
 r=copy.deepcopy(positive);edit(r)
 try:check(r)
 except ValueError as e:assert str(e)==reason,(label,str(e));rows.append({'name':label,'reason':str(e)})
 else:raise AssertionError('accepted '+label)
destination=root/'build/native-body-report-controls'/str(uuid.uuid4());destination.mkdir(parents=True)
out={'passed':True,'controls':rows,'positiveReport':str(report_path),'positiveSha256':sha(report_path),'checkerHashes':{str(base/n):sha(base/n) for n in ['native_c64_ast.py','native_divmod_ast.py','native_divmod.py','native_body_report.py']}}
out['checkerHashes'][str(pathlib.Path(__file__).resolve())]=sha(pathlib.Path(__file__).resolve())
p=destination/'report.json';p.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'passed':True,'controls':len(rows),'report':str(p),'sha256':sha(p)}))
