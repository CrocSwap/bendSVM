"""Bound source/C closure proofs and six semantic negative controls."""
import sys,json,pathlib,copy,os
if not __debug__:raise RuntimeError('modular proof requires Python assertions')
import z3 as z
from modular_c import check,need
from modular_report import FIXTURES,RECIPES,SCOPE,sha,snapshot,validate

def main(input_path,output):
 need(not output.exists(),'output already exists');raw=input_path.read_bytes();data=json.loads(raw)
 need(data['version']==1 and isinstance(data['runId'],str) and len(data['runId'])==36,'input header')
 need(z.get_version_string()=='5.1.0','solver version');before=data['sourceHashes'];need(before and snapshot(before)==before,'source binding')
 need(data['fixtures']==[{'file':f,'roots':roots} for f,roots in FIXTURES] and len(data['programs'])==len(FIXTURES),'fixture inventory')
 rows=[]
 for p,(file,roots) in zip(data['programs'],FIXTURES):
  need(p['source']['source']==file and p['source']['roots']==roots and p['artifact']['fixture']==file,'fixture identity')
  need(set(p['sourceHashes'])==set(p['source']['files']),'checked file inventory')
  for name,h in p['sourceHashes'].items():
   relative=os.path.relpath(os.path.abspath(name),os.getcwd());need(before.get(relative)==h and sha(pathlib.Path(name).read_bytes())==h,'unbound checked file')
  proof=check(p);need(proof['passed'],'closure equivalence failed')
  rows.append({'fixture':file,'cSha256':p['artifact']['cSha256'],'proof':proof})
 mutations=[]
 for i,name,old,new,target in RECIPES:
  p=copy.deepcopy(data['programs'][i]);need(p['artifact']['c'].count(old)==1,'mutation target count')
  p['artifact']['c']=p['artifact']['c'].replace(old,new);p['artifact']['cSha256']=sha(p['artifact']['c'].encode())
  proof=check(p);need(not proof['passed'] and proof['claims'][-1]['function']==target and proof['claims'][-1]['result']=='sat','missing semantic counterexample')
  mutations.append({'name':name,'programIndex':i,'cSha256':p['artifact']['cSha256'],'proof':proof})
 report={'passed':True,'endToEndVerified':False,'version':1,'runId':data['runId'],'inputSha256':sha(raw),'sourceHashes':before,'cSyntax':data['cSyntax'],'z3':z.get_version_string(),'results':rows,'mutations':mutations,'scope':SCOPE}
 validate(report,data,raw);need(input_path.read_bytes()==raw and snapshot(before)==before,'input/source drift')
 with output.open('x') as f:json.dump(report,f,indent=2)
 print('All five modular closures passed; six semantic faults detected')
if __name__=='__main__':main(pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]))
