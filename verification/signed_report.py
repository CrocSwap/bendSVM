"""Exact signed SDK source semantics and emitted-C report inventory."""
import json,pathlib,sys,math
if not __debug__:raise RuntimeError('signed report requires Python assertions')
from modular_report import claims,sha,snapshot
from modular_c import need
from signed_semantics import CLAIMS
ROOTS=['extend32','byte_bits','mul8','add32_wrap']
SCOPE='Total signed-width source semantics and pure emitted-C equivalence. Exporter, evaluators, schema, proof driver and Z3 trusted. Caller bounds, memory ABI, Clang and SBF preservation excluded.'
def validate(report,data,raw):
 need(set(report)=={'passed','endToEndVerified','version','runId','inputSha256','sourceHashes','cSyntax','semantics','lowering','scope'},'report fields')
 need(report['passed'] is True and report['endToEndVerified'] is False and report['scope']==SCOPE,'scope flags')
 need(type(report['version']) is int and report['version']==1,'version')
 need(report['runId']==data['runId'] and report['inputSha256']==sha(raw),'run/input binding')
 need(report['sourceHashes']==data['sourceHashes'],'source binding')
 required={'verification/'+n for n in ['signed-source.ts','check-signed-lowering.ts','signed_lowering.py','signed_semantics.py','signed_report.py','modular_c.py','modular_report.py','acyclic_c.py','prove.py','model.ts','tagged_sum_c.py','tagged_sum_layout.py','tagged_sum_rendering.py','adapter_contract_c.py']}
 need(required<=set(data['sourceHashes']),'checker inventory')
 need(data['fixtures']==[{'file':'sdk/signed.bend','roots':ROOTS}],'fixture inventory')
 p=data['program'];need(p['source']['source']==p['artifact']['fixture']=='sdk/signed.bend' and p['source']['roots']==ROOTS,'fixture identity')
 need(p['defaultProductionCMatches'] is True and p['source']['schema']==p['artifact']['schema'],'production/schema binding')
 need(p['artifact']['cSha256']==sha(p['artifact']['c'].encode()),'C hash')
 need(report['cSyntax']==data['cSyntax'],'frontend binding')
 need(isinstance(data['cSyntax']['compiler'],str) and data['cSyntax']['compiler'] and isinstance(data['cSyntax']['version'],str) and data['cSyntax']['version'].strip(),'frontend identity')
 need(data['cSyntax']['units']==[{'fixture':'sdk/signed.bend','cSha256':p['artifact']['cSha256'],'exitCode':0}],'frontend inventory')
 semantic=report['semantics'];need(set(semantic)=={'passed','z3','claims'} and semantic['passed'] is True and semantic['z3']=='5.1.0','semantic fields')
 need([r['name'] for r in semantic['claims']]==CLAIMS,'semantic inventory')
 for r in semantic['claims']:
  need(set(r)=={'name','result','seconds'} and r['result']=='unsat','unproved semantic claim')
  need(type(r['seconds']) in (int,float) and math.isfinite(r['seconds']) and r['seconds']>=0,'timing')
 lower=report['lowering'];need(set(lower)=={'passed','roots','claims'} and lower['passed'] is True and lower['roots']==ROOTS,'lowering fields')
 claims(lower['claims'],p)
if __name__=='__main__':
 raw=pathlib.Path(sys.argv[1]).read_bytes();data=json.loads(raw);validate(json.loads(pathlib.Path(sys.argv[2]).read_text()),data,raw)
 need(snapshot(data['sourceHashes'])==data['sourceHashes'],'source drift')
 print('Signed semantic/C report inventory and bindings passed')
