import copy,importlib.util,json,pathlib
import sys
sys.path.insert(0,"verification")
from vault_adapter_inventory import validate_input
r=pathlib.Path('build/vault-adapter-bridge');spec=importlib.util.spec_from_file_location('gate',pathlib.Path('verification/vault_adapter_bridge.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
fresh=json.loads((r/'fresh-receipt.json').read_text());ip=pathlib.Path(fresh['input']);data=json.loads(ip.read_text());reports=[json.loads((ip.parent/n).read_text()) for n in ['report.json','codec-report.json','call-premises-report.json','codec-semantics-report.json','semantic-report.json']]
controls=[('duplicate-codec-claim',lambda a:a[1]['codec']['claims'].__setitem__(1,copy.deepcopy(a[1]['codec']['claims'][0]))),('wrong-call-callee',lambda a:a[2]['calls'][0].update(callee='unrelated_decoder')),('missing-premise-label',lambda a:a[2]['positive']['obligationKinds'].remove('bridge: root signed input is canonical Bool')),('wrong-call-size',lambda a:a[2]['calls'][0].update(bytes=75)),('wrong-call-source',lambda a:a[2]['calls'][0].update(source="('data', 1)")),('wrong-call-output',lambda a:a[2]['calls'][0].update(output='instruction')),('duplicate-premise-label',lambda a:a[2]['positive']['obligationKinds'].__setitem__(10,a[2]['positive']['obligationKinds'][9])),('duplicate-primitive-claim',lambda a:a[1]['primitive']['claims'].__setitem__(1,copy.deepcopy(a[1]['primitive']['claims'][0])))]
results=[]
for name,mutate in controls:
 bad=copy.deepcopy(reports);mutate(bad)
 try:m.validate(bad,data,m.sha(ip))
 except (ValueError,RuntimeError) as e:results.append({'name':name,'rejection':str(e)})
 else:raise RuntimeError('escaped '+name)
inputs=[('wrong-root',lambda d:d['fixture'].update(root='process')),('wrong-source',lambda d:d['program']['source'].update(source='examples/vault/vault.bend')),('wrong-native',lambda d:d['fixture']['files'].__setitem__('vault.h',d['fixture']['files']['vault.h']+'\n')),('wrong-schema',lambda d:d['program']['source']['schema'].update(version=100)),('wrong-include',lambda d:d['fixture']['files'].__setitem__('vault.wire.h',d['fixture']['files']['vault.wire.h'].replace('vault.h','unrelated.h',1))),('missing-artifact',lambda d:d['artifactHashes'].pop(next(iter(d['artifactHashes'])))),('wrong-hash',lambda d:d['artifactHashes'].__setitem__(next(iter(d['artifactHashes'])),'0'*64)),('wrong-size',lambda d:d['fixture']['interface'].update(stateBytes=95))]
for name,mutate in inputs:
 bad=copy.deepcopy(data);mutate(bad)
 try:validate_input(bad)
 except (ValueError,RuntimeError) as e:results.append({'name':name,'rejection':str(e)})
 else:raise RuntimeError('escaped '+name)
m.validate(reports,data,m.sha(ip))
(r/'inventory-tests.json').write_text(json.dumps({'passed':True,'freshReceiptSha256':m.sha(r/'fresh-receipt.json'),'reportRefusals':len(controls),'inputRefusals':len(inputs),'results':results,'checkerSha256':m.sha(pathlib.Path('verification/vault_adapter_inventory.py')),'testSha256':m.sha(__file__)},indent=2)+'\n');print('8 report refusals, 8 input refusals passed')
