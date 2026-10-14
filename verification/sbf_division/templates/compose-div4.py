"""Compose fresh universal step contracts through mechanically checked interfaces."""
from pathlib import Path
import contextlib,hashlib,json,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
import sbf_cfg as cfg
import z3 as z
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
files=[base/n for n in ['prove-div4-first-step.py','prove-div4-step2.py','prove-div4-last-steps.py','prove-div4.py']]
def fresh(file,capture=False):
 text=file.read_text()
 if capture:
  text=text.replace('rows=[];states={}','rows=[];states={};contexts={}')
  needle="out=state['registers'];memory=state['memory'];states[str(step)]="
  assert needle in text
  text=text.replace(needle,"contexts[step]={'registers':regs,'memory':mem,'state':state,'q':q,'r':r,'d':d,'want_q':wq,'want_r':wr,'parameters':{'rawlo':rawlo,'rawhi':rawhi,'qlo':qlo,'previous_lo':previous_lo,'partial_hi':partial_hi,'carry':carry,'dh':dh,'dl':dl}}\n "+needle)
 ns={'__file__':str(file),'__name__':'fresh_contract'}
 exec(compile(text,str(file),'exec'),ns);return ns
with (base/'div4-composition-prerequisites.log').open('w') as f,contextlib.redirect_stdout(f):
 first=fresh(files[0]);second=fresh(files[1]);last=fresh(files[2],True)
text=first['ns']['text'];address=first['ns']['address']
# Static register/stack liveness is independent of the symbolic state merging.
def live(entry,stop):
 ins,succ,cone=cfg.acyclic_cone(text,address,entry,stop);result={stop:(set(),set())}
 for at in sorted(cone-{stop},reverse=True):
  op,ds,off,imm=ins[at];dst=ds&15;src=ds>>4;reads=set();writes=set();loads=set();stores=set()
  if op in cfg.BRANCHES:
   if op!=5:reads.add(dst)
   if op&8:reads.add(src)
  elif op in (0x61,0x79):
   reads.add(src);writes.add(dst)
   if op==0x79 and src==10:loads.add(off)
  elif op in (0x63,0x7b):
   reads.update([dst,src])
   if dst==10:
    if op!=0x7b:raise RuntimeError('partial stack write unsupported in liveness')
    stores.add(off)
  elif op in (0x62,0x7a):reads.add(dst)
  elif op==0xbf:reads.add(src);writes.add(dst)
  elif op in (0xb7,0x18):writes.add(dst)
  elif op in (0x67,0x77,0x57,0x47):reads.add(dst);writes.add(dst)
  elif op in (0x1f,0x5f,0x4f):reads.update([dst,src]);writes.add(dst)
  else:raise RuntimeError('unknown liveness opcode '+hex(op))
  rr=set();mm=set()
  for target in succ[at]:
   if target in cone:rr|=result[target][0];mm|=result[target][1]
  result[at]=(reads|(rr-writes),loads|(mm-stores))
 return result[entry]
rows=[]
def prove(name,claim):
 s=z.Solver();s.set(timeout=30000);s.add(z.Not(claim));r=s.check()
 if r!=z.unsat:raise RuntimeError((name,str(r),s.reason_unknown()))
 rows.append({'name':name,'result':str(r)})
low=lambda v:z.Extract(31,0,v)
contracts={1:{'state':first['state'],'want_q':first['q1'],'want_r':first['r1'],'d':first['ns']['d']},2:{'registers':second['regs'],'memory':second['mem'],'state':second['state'],'q':second['q'],'r':second['r'],'d':second['d'],'want_q':second['want_q'],'want_r':second['want_r'],'parameters':{k:second[k] for k in ['rawlo','rawhi','qlo','oldhi','oldlo','dh','dl']}},**last['contexts']}
interfaces=[]
for index,entry,stop in [(2,0x5e08,0x5fb0),(3,0x5fb0,0x6158),(4,0x6158,0x6390)]:
 prev=contracts[index-1];cur=contracts[index];rr=prev['state']['registers'];mm=prev['state']['memory'];params=cur['parameters']
 values={'rawlo':rr[5],'rawhi':rr[7 if index in [2,4] else 8],'dh':z.Extract(63,32,prev['d']),'dl':low(prev['d'])}
 if index==2:values.update(qlo=mm[-24],oldhi=rr[4],oldlo=rr[9])
 elif index==3:values.update(qlo=mm[-32],previous_lo=mm[-24],partial_hi=rr[4],carry=z.Extract(0,0,rr[9]))
 else:values.update(qlo=rr[9],previous_lo=mm[-32],partial_hi=rr[4],carry=z.Extract(0,0,rr[2]))
 pairs=[(params[k],v) for k,v in values.items()]
 def sub(v):return v if isinstance(v,tuple) else z.substitute(v,*pairs)
 def equal(a,b):
  if isinstance(a,tuple) or isinstance(b,tuple):
   if not isinstance(a,tuple) or not isinstance(b,tuple) or a!=b:raise RuntimeError('pointer interface mismatch')
   return z.BoolVal(True)
  if a is None or b is None:raise RuntimeError('live poisoned register')
  return a==b
 needed_regs,needed_stack=live(entry,stop)
 prove('boundary '+str(index-1)+' to '+str(index)+' live registers and stack',z.And(*[equal(rr[k],sub(cur['registers'][k])) for k in sorted(needed_regs)],*[equal(mm[k],sub(cur['memory'][k])) for k in sorted(needed_stack)]))
 # Bind even unread declared memory: later blocks may rely on its preservation.
 # The output pointer slot is absent only from step2's abstract scalar contract;
 # the exact no-write check below discharges its separate frame rule.
 full_memory=dict(mm)
 if -40 not in full_memory:full_memory[-40]=first['state']['memory'][-40]
 prove('boundary '+str(index-1)+' to '+str(index)+' complete declared entry memory',z.And(*[equal(full_memory[k],sub(v)) for k,v in cur['memory'].items()]))
 if index==2:
  fault=z.Solver();fault.set(timeout=30000);fault.add(z.Not(rr[6]==(sub(cur['registers'][6])^1)))
  if fault.check()!=z.sat:raise RuntimeError('missed divisor interface fault')
  boundary_fault={'result':'sat','name':'changed divisor high-bit at interface','witness':str(fault.model())}
 prove('boundary '+str(index-1)+' to '+str(index)+' mathematical state',z.And(sub(cur['q'])==prev['want_q'],sub(cur['r'])==prev['want_r'],sub(cur['d'])==prev['d']))
 interfaces.append({'from':index-1,'to':index,'liveRegisters':sorted(needed_regs),'liveStack':sorted(needed_stack)})
# Step1/2 do not write this pointer slot after its initial save. Model transitions
# copy untouched memory, so the opaque output pointer remains available at step4.
for entry,stop in [(0x5e08,0x5fb0),(0x5fb0,0x6158)]:
 ins,_,cone=cfg.acyclic_cone(text,address,entry,stop)
 assert all(not(op in (0x7b,0x63,0x62,0x7a) and ds&15==10 and off==-40) for at,(op,ds,off,imm) in ins.items() if at in cone-{stop})
assert first['state']['memory'][-40]==('output',0)
assert last['contexts'][3]['state']['memory'][-40]==('output',0)
proof_files=[base/n for n in ['div4-first-step-report.json','div4-step2-report.json','div4-last-steps-report.json']]
for p in proof_files:
 d=json.loads(p.read_text());assert d['passed']
 for f,h in d['inputHashes'].items():assert sha(f)==h
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':rows,'boundaryFault':boundary_fault,'interfaces':interfaces,'modeledInstructions':55+52+52+70,'scope':'Fresh universal contracts for all four emitted div4 steps; live register/stack and mathematical q/r/d interfaces checked by substitution, with opaque output-pointer frame preserved. Establishes final tagged40byte output equals four restoring-division steps under explicit valid/disjoint native ABI regions and the exploratory memory/poison model. Final EXIT, VM execution, formal source extraction and caller/div16/quotient composition are outside scope.','inputHashes':{str(p):sha(p) for p in [Path(__file__),*files,repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',base/'paths-div4.py',base/'paths-div4-frames.py']},'prerequisites':{str(p):sha(p) for p in proof_files},'logSha256':sha(base/'div4-composition-prerequisites.log')}
(base/'div4-composition-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'interfaces':interfaces,'claims':len(rows),'modeledInstructions':229}))
