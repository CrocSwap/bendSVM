"""Exact report acceptance for the conditional account decoder template model."""
from pathlib import Path
import hashlib,json,re
if not __debug__:raise RuntimeError('loader report assertions required')
SCOPE=('Conditional model of the parsed read_account statement template and its eight-byte read_le calls. '
       'Assumes valid aligned loader allocation, 64-bit address casts, byte memory and disjoint native descriptor objects. '
       'No arbitrary C, VM memory mapping, syscall, LLVM or SBF preservation theorem.')
CLAIMS=['read-le8']+['read-bounds-'+n for n in ['marker','signer','writable','executable','size','rent']]+['duplicate-marker']+[
 n+'-address' for n in ['key','owner','lamports','data']]+[n+'-flag' for n in ['signer','writable','executable']]+[
 'data-length','rent-address','next-account-address','rent-value','nonwrapping-intermediates','data-and-rent-disjoint',
 'next-account-aligned','lamports-aligned']+['field-span-'+n for n in ['key','owner','lamports']]
sha=lambda raw:hashlib.sha256(raw).hexdigest()
def need(ok,reason):
 if not ok:raise ValueError(reason)
def validate_input(data):
 need(set(data)=={'version','runId','headerArtifact','headerSha256','sourceHashes','cSyntax'},'input fields')
 need(type(data['version']) is int and data['version']==1 and isinstance(data['runId'],str) and bool(data['runId']),'input identity')
 base=Path(__file__).resolve().parent
 required={str((base/name).relative_to(Path.cwd())) for name in ['loader_model.py','loader_profile.py','loader_report.py']}
 required|={'runtime/solana_min.h','verification/adapter_contract_c.py','verification/collection_caller_syntax.py','verification/check-loader.ts'}
 need(isinstance(data['sourceHashes'],dict) and required<=set(data['sourceHashes']),'required source inventory')
 need(all(isinstance(n,str) and isinstance(h,str) and re.fullmatch('[0-9a-f]{64}',h) for n,h in data['sourceHashes'].items()),'source hash format')
 need(set(data['cSyntax'])=={'compiler','compilerSha256','exitCode','log','logSha256','unit','unitSha256'},'frontend inventory')
 need(type(data['cSyntax']['exitCode']) is int and data['cSyntax']['exitCode']==0,'frontend status')
 need(Path(data['cSyntax']['unit']).parent==Path(data['headerArtifact']).parent,'frontend header directory')
 need(Path(data['cSyntax']['unit']).read_text()=='#include "solana_min.h"\n_Static_assert(sizeof(void *) == 8, "64-bit native address profile");\n','frontend unit contract')
 need(Path(data['headerArtifact']).name=='solana_min.h','header filename')
def validate(r,data,raw):
 validate_input(data)
 need(set(r)=={'passed','endToEndVerified','version','z3','runId','inputSha256','sourceHashes','headerSha256','claims','successWitness','scope'},'report fields')
 need(r['passed'] is True and r['endToEndVerified'] is False and r['scope']==SCOPE,'report scope')
 need(type(r['version']) is int and r['version']==1 and r['z3']=='5.1.0','report version')
 need(r['runId']==data['runId'] and r['inputSha256']==sha(raw),'run/input binding')
 need(r['sourceHashes']==data['sourceHashes'],'source binding')
 need(r['headerSha256']==data['headerSha256']==data['sourceHashes']['runtime/solana_min.h'],'header binding')
 need(r['claims']==[{'name':n,'result':'unsat'} for n in CLAIMS],'claim inventory/results')
 need(r['successWitness']=='sat','success witness')
def unchanged(data):
 validate_input(data)
 for name,h in data['sourceHashes'].items():need(sha(Path(name).read_bytes())==h,'source drift: '+name)
 need(sha(Path(data['headerArtifact']).read_bytes())==data['headerSha256'],'header drift')
 for name,key in [('compiler','compilerSha256'),('log','logSha256'),('unit','unitSha256')]:
  need(sha(Path(data['cSyntax'][name]).read_bytes())==data['cSyntax'][key],'frontend artifact drift')
if __name__=='__main__':
 import sys
 raw=Path(sys.argv[1]).read_bytes();data=json.loads(raw);unchanged(data)
 validate(json.loads(Path(sys.argv[2]).read_bytes()),data,raw);unchanged(data)
 print('Loader report inventory and artifact bindings passed')
