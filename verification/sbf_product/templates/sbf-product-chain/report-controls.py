from pathlib import Path
import copy,hashlib,importlib.util,json,uuid,os
if not __debug__:raise RuntimeError('assertions required')
base=Path(__file__).resolve().parent;s=importlib.util.spec_from_file_location('v',base/'validate.py');v=importlib.util.module_from_spec(s);s.loader.exec_module(v)
run=Path(json.loads(Path(os.environ.get('SBF_CHAIN_LATEST',str(base/'latest.json'))).read_text())['runRoot']);schema=json.loads((base/'report-schema.json').read_text());rows=[]
v.validate_run(run)
def reject(relative,d,reason):
 try:v.validate_report(run,relative,d,schema)
 except ValueError as e:
  if str(e)!=reason:raise RuntimeError((relative,str(e),reason))
  rows.append({'report':relative,'reason':str(e)})
 else:raise RuntimeError('corruption accepted')
for relative in schema:
 original=json.loads((run/relative).read_text())
 d=copy.deepcopy(original);d.pop('scope');reject(relative,d,'report fields')
 d=copy.deepcopy(original);d['passed']=False;reject(relative,d,'report status')
 d=copy.deepcopy(original);d['inputHashes'].pop(next(iter(d['inputHashes'])));reject(relative,d,'input inventory')
 d=copy.deepcopy(original);key=next(iter(d['inputHashes']));d['inputHashes'][key]='0'*64;reject(relative,d,'file hash: '+key)
 d=copy.deepcopy(original);d['scope']='whole handler verified';reject(relative,d,'scope text')
 d=copy.deepcopy(original)
 if 'endToEndVerified' in d:d['endToEndVerified']=True;reason='scope overclaim'
 else:d['endToEndVerified']=True;reason='report fields'
 reject(relative,d,reason)
name='build/sbf-operand-probe/paths-report.json';d=json.loads((run/name).read_text());d['baseline']['reachability']='unsat';reject(name,d,'path claims')
name='build/sbf-carry-probe/product-report.json';d=json.loads((run/name).read_text());d['claims'][0]['result']='unknown';reject(name,d,'arithmetic results')
name='build/sbf-carry-probe/composition-report.json';d=json.loads((run/name).read_text());d['matchedRegisters']=10;reject(name,d,'composition frame')
name='build/sbf-operand-probe/linked-product-report.json';d=json.loads((run/name).read_text());d['boundary']['carryExtraStackSlots']=[-288];reject(name,d,'linked boundary')
name='build/sbf-product-tail/report.json';d=json.loads((run/name).read_text());d['extraStackBoundary']['result']='sat';reject(name,d,'tail results')
name='build/sbf-operand-probe/controls-report.json';d=json.loads((run/name).read_text());d['controls'][0]['reason']='unrelated error';reject(name,d,'control reason')
name='build/sbf-operand-probe/layout-report.json';d=json.loads((run/name).read_text());d['fields'][0]['offset']=88;reject(name,d,'layout fields')
name='build/sbf-entry-product-replay/replay-report.json';d=json.loads((run/name).read_text());d['rows'][-1]['result']['ok']=True;reject(name,d,'runtime outcomes')
name='build/sbf-product-chain/artifact-report.json';d=json.loads((run/name).read_text());d['byteIdentical']=False;reject(name,d,'artifact rebuild identity')
for field,value,reason in [('passed',False,'fresh build status'),('exitCode',1,'fresh build status'),('bunVersion','0','fresh pins'),('bendCommit','0','fresh pins'),('command',[],'fresh command'),('matchedArtifacts',{},'fresh artifact identity'),('outputHashes',{},'fresh file inventory')]:
 name='build/sbf-product-chain/artifact-report.json';d=json.loads((run/name).read_text());d['freshSourceBuild'][field]=value;reject(name,d,reason)
v.validate_run(run)
out=Path(os.environ.get('SBF_PRODUCT_REPORT_CONTROLS',str(Path.cwd()/'build/sbf-product-report-controls')))/str(uuid.uuid4());out.mkdir(parents=True)
report={'passed':True,'runRoot':str(run),'validatorSha256':v.sha(base/'validate.py'),'schemaSha256':v.sha(base/'report-schema.json'),'controllerSha256':v.sha(Path(__file__)),'refusals':rows};(out/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'refusals':len(rows),'report':str(out/'report.json')}))
