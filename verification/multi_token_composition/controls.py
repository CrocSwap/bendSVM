"""Existential frame mutations against the same maintained composition model."""
import json,sys
from pathlib import Path
sys.path.insert(0,'verification')
import multi_adapter_contract as m
from multi_token_composition.common import begin,finish,sha,need,NAMES
from multi_token_composition.model import analyse_fixture
if len(sys.argv)!=5:raise ValueError('usage: controls.py INPUT POSITIVE FAULT OUTPUT')
input_path,positive_path,fault,output_path=sys.argv[1:]
need(fault in ('managed-byte','decimals'),'unknown frame mutation')
data,binding,out=begin(input_path,output_path)
positive_path=str(Path(positive_path).resolve());positive_hash=sha(positive_path);positive=json.loads(Path(positive_path).read_text())
need(positive['passed'] is True and positive['kind']=='positive','positive prerequisite')
need(positive['binding']==binding,'positive input/source binding')
need([r['fixture'] for r in positive['fixtures']]==NAMES,'positive fixture inventory')
rows=[]
for f,positive_row in zip(data['fixtures'],positive['fixtures']):
 witnesses=positive_row['activeTransferWitnesses']
 need(len(witnesses)==2 and [w['name'] for w in witnesses]==['reachable-0','reachable-1'] and all(w['result']=='sat' and w['witness'] for w in witnesses),'positive active witnesses')
 try:analyse_fixture(f,fault=fault,witness=witnesses[0]['witness'])
 except m.SymSemantic as error:
  expected='actual-effects: sequential managed bytes preserved' if fault=='managed-byte' else 'actual-effects: sequential decimals preserved'
  need(expected in error.model['failed'] and error.model['completeModel'],'wrong semantic counterexample')
  rows.append({'fixture':f['name'],'fault':fault,'expected':expected,'reason':str(error),'counterexample':error.model,'witnessPins':'Positive initialize witness scalars, existential control only'})
  print(f['name']+' '+fault+' rejected for expected semantic reason',flush=True)
 else:raise RuntimeError('accepted faulty frame')
finish(data,binding,out,'frame-control',rows,{positive_path:positive_hash})
