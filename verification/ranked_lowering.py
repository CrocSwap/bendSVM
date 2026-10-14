"""Bound source/C closure proofs with decreasing Nat ranks."""
import sys,json,pathlib,copy,os
if not __debug__:raise RuntimeError('ranked proof requires Python assertions')
import z3 as z
from ranked_c import check,need
from ranked_report import FIXTURES,SCOPE,sha,snapshot,validate

def main(input_path,output):
 need(not output.exists(),'output already exists');raw=input_path.read_bytes();data=json.loads(raw)
 need(data['version']==1 and isinstance(data['runId'],str) and len(data['runId'])==36,'input header')
 need(z.get_version_string()=='5.1.0','solver version');before=data['sourceHashes'];need(before and snapshot(before)==before,'source binding')
 need(data['fixtures']==FIXTURES and len(data['programs'])==len(FIXTURES),'fixture inventory')
 rows=[]
 for p,fixture in zip(data['programs'],FIXTURES):
  file,roots=fixture['file'],fixture['roots']
  need(p['source']['source']==file and p['source']['roots']==roots and p['artifact']['fixture']==file,'fixture identity')
  need(set(p['sourceHashes'])==set(p['source']['files']),'checked file inventory')
  for name,h in p['sourceHashes'].items():
   relative=os.path.relpath(os.path.abspath(name),os.getcwd());need(before.get(relative)==h and sha(pathlib.Path(name).read_bytes())==h,'unbound checked file')
  proof=check(p);need(proof['passed'],'closure equivalence failed')
  rows.append({'fixture':file,'cSha256':p['artifact']['cSha256'],'proof':proof})
 report={'passed':True,'endToEndVerified':False,'version':1,'runId':data['runId'],'inputSha256':sha(raw),'sourceHashes':before,'cSyntax':data['cSyntax'],'z3':z.get_version_string(),'results':rows,'scope':SCOPE}
 validate(report,data,raw);need(input_path.read_bytes()==raw and snapshot(before)==before,'input/source drift')
 with output.open('x') as f:json.dump(report,f,indent=2)
 print('All ranked closures and termination obligations passed')
if __name__=='__main__':main(pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]))
