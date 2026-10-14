"""Fresh joint source-semantics and default emitted-C qualification."""
import json,sys,pathlib,os
if not __debug__:raise RuntimeError('signed proof requires Python assertions')
import z3 as z
from signed_semantics import check as semantics
from modular_c import check as lowering,need
from signed_report import validate,sha,snapshot,SCOPE

def main(input_file,output):
 need(not output.exists(),'output exists');raw=input_file.read_bytes();data=json.loads(raw)
 need(data['version']==1 and isinstance(data['runId'],str) and len(data['runId'])==36,'input header')
 need(z.get_version_string()=='5.1.0','solver pin');before=data['sourceHashes'];need(before and snapshot(before)==before,'source binding')
 p=data['program'];need(set(p['sourceHashes'])==set(p['source']['files']),'checked-file inventory')
 for file,h in p['sourceHashes'].items():need(before.get(os.path.relpath(os.path.abspath(file)))==h and sha(pathlib.Path(file).read_bytes())==h,'unbound checked file')
 source=semantics(p);c=lowering(p);need(c['passed'],'C preservation failed')
 report={'passed':True,'endToEndVerified':False,'version':1,'runId':data['runId'],'inputSha256':sha(raw),'sourceHashes':before,'cSyntax':data['cSyntax'],'semantics':source,'lowering':c,'scope':SCOPE}
 validate(report,data,raw);need(input_file.read_bytes()==raw and snapshot(before)==before,'source/input drift')
 with output.open('x') as f:json.dump(report,f,indent=2);f.write('\n')
 print('Signed source semantics and C lowering passed')
if __name__=='__main__':main(pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]))
