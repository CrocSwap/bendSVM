"""Strict report inventory for the ignored native64 bridge probe."""
import json,pathlib
import native_divmod_ast as division_model
from native_divmod import certify as certify_divmod
SCOPE='Six PROOF-root native leaves: checked-source multiplication/division certificates plus actual pinned SBF Clang AST arithmetic models. AST frontend/model/driver, C data model and maker interpretation trusted; not SBF execution theorem.'
def validate(output,data,source_proof,inputs,version,compiler,run,model,certify,mangle,sha):
 need=model.need
 need(set(output)=={'passed','endToEndVerified','sourceHashes','frontendVersion','rows','scope'},'report fields')
 need(output['passed'] is True and output['endToEndVerified'] is False and output['scope']==SCOPE,'scope flags')
 need(output['sourceHashes']==inputs,'source inventory')
 for p,h in inputs.items():need(sha(pathlib.Path(p))==h,'source drift')
 need(output['frontendVersion']==version,'frontend binding')
 expected_rows=[(p,operation) for p in data['programs'] for operation in ['mul32','divmod']]
 need([(r['fixture'],r.get('operation')) for r in output['rows']]==[(p['source']['source'],operation) for p,operation in expected_rows],'fixture inventory')
 need(model.z.get_version_string()=='5.1.0','solver pin')
 for row,(p,operation) in zip(output['rows'],expected_rows):
  need(set(row)=={'fixture','operation','sourceCertificate','nativeProof','command','artifacts'},'row fields')
  certificate=(certify(p,source_proof['prerequisite'],data['sourceModels']['math'].encode()) if operation=='mul32' else certify_divmod(p,source_proof['divisionPrerequisite'],data['sourceModels']['division'].encode()))
  need(row['sourceCertificate']==certificate,'source certificate')
  expected_proof={'result':'unsat'} if operation=='mul32' else {'result':'unsat','returns':2,'safetyObligations':3,'operators':['|','|','/','%']}
  need(row['nativeProof']==expected_proof,'native proof')
  leaf_model=model if operation=='mul32' else division_model
  label=pathlib.Path(row['fixture']).parent.name+'-'+operation;header=run/(label+'.h');wrapper=run/(label+'.c');ast=run/(label+'.ast.json');log=run/(label+'.log');symbol=mangle(certificate['sourceFunction'])
  expected=[str(compiler),'--target=sbf','-mcpu=generic','-ffreestanding','-fno-builtin','-fno-stack-protector','-std=c17','-fsyntax-only','-Xclang','-ast-dump=json','-Xclang','-ast-dump-filter','-Xclang',symbol,str(wrapper)]
  need(row['command']==expected,'frontend command')
  need(set(row['artifacts'])=={str(f) for f in [header,wrapper,ast,log]},'artifact inventory')
  for file,h in row['artifacts'].items():need(sha(pathlib.Path(file))==h,'artifact binding')
  need(header.read_text()==p['artifact']['c'],'C input binding')
  need(wrapper.read_text()=='#include "'+header.name+'"\n','wrapper binding')
  need(leaf_model.prove(json.loads(ast.read_text()),symbol)==row['nativeProof'],'rechecked native proof')
