"""Actual emitted effect mapping versus checked source, including amount mutation."""
from pathlib import Path
import copy,hashlib,json,sys
sys.path.insert(0,'verification')
from acyclic_c import Source,C,check,mangle,wire,z
from effect_semantics import Extraction
if not __debug__:raise RuntimeError('assertions required')
assert z.get_version_string()=='5.1.0'
from multi_token_composition.common import begin,finish
if len(sys.argv)!=3:raise ValueError('usage: mapping.py INPUT OUTPUT')
data,binding,report_path=begin(*sys.argv[1:]);root=report_path.parent
rows=[]
for original in data['fixtures']:
 for fault in [False,True]:
  f=copy.deepcopy(original);program=f['program'];header=f['name']+'.h'
  if fault:
   old='ToCustody_make(), (a2).as.c0.f1,';new='ToCustody_make(), (a2).as.c0.f2,'
   text=f['files'][header];assert text.count(old)==1
   text=text.replace(old,new);f['files'][header]=text;program['artifact']['c']=text;program['artifact']['cSha256']=hashlib.sha256(text.encode()).hexdigest()
  root_checks=check(program);assert len(root_checks)==1 and root_checks[0]['result']==('sat' if fault else 'unsat')
  source=Source(program['source']);c=C(source,program['artifact'])
  name=program['source']['roots'][0];fn=program['source']['functions'][name]
  args=[z.Const('mapping_arg_'+str(i),source.sort(t)) for i,t in enumerate(fn['args'])]
  expected=source.call(name,args,z.BoolVal(True));actual=c.call(mangle(name),args,z.BoolVal(True))
  out=source.sort(fn['result']);accepted=next(v for v in source.types[fn['result']]['variants'] if v['name'].split('.')[-1]=='Accepted')['tag']
  accept=z.And(out.recognizer(accepted)(expected),out.recognizer(accepted)(actual))
  extraction=Extraction(source,{**f,'interface':{**f['interface'],'version':1}})
  expected_ok,expected_slots=extraction.extract(out.accessor(accepted,1)(expected))
  actual_ok,actual_slots=extraction.extract(out.accessor(accepted,1)(actual))
  different=z.Or(actual_ok!=expected_ok,*[left[loc]!=right[loc] for left,right in zip(actual_slots,expected_slots) for loc in left])
  solver=z.Solver();solver.set(timeout=30000);solver.add(accept,different)
  status=solver.check();assert str(status)==('sat' if fault else 'unsat'),str(status)
  row={'fixture':f['name'],'fault':'first-amount-from-withdrawal' if fault else None,'rootChecks':root_checks,'slotMappingResult':str(status),'headerSha256':program['artifact']['cSha256']}
  if fault:
   model=solver.model()
   row['wireArgs']=[wire(source,t,model.eval(a,model_completion=True)) for t,a in zip(fn['args'],args)]
   row['firstAmount']={label:str(model.eval(slots[0][('amount',)],model_completion=True)) for label,slots in [('actual',actual_slots),('expected',expected_slots)]}
   assert row['firstAmount']['actual']!=row['firstAmount']['expected']
   path=root/(f['name']+'-wrong-effect-amount.h');path.write_text(program['artifact']['c']);row['mutatedHeader']=str(path)
  rows.append(row)
  print(f['name']+' '+str(fault)+' mapping '+str(status),flush=True)
finish(data,binding,report_path,'effect-mapping',rows)
