"""Connect actual product/overflow state to the current division branches."""
from pathlib import Path
import contextlib,hashlib,json
base=Path(__file__).resolve().parent;repo=base.parents[1]
def fresh(name,log):
 p=base/name;ns={'__file__':str(p.resolve())}
 with (base/log).open('w') as out,contextlib.redirect_stdout(out):exec(compile(p.read_text(),str(p),'exec'),ns)
 return ns
bridge=fresh('link-denominator.py','caller-entry-product-prerequisite.log');route=fresh('check-call-routes.py','caller-entry-routes-prerequisite.log');caller=fresh('check-caller-calls.py','caller-entry-calls-prerequisite.log');z=route['z']
actual=bridge['state'];rr=actual['registers'];mm=actual['memory'];low=lambda v:z.Extract(31,0,v);high=lambda v:z.Extract(63,32,v)
tail=bridge['tail'];tr,tm,_=tail.execute(tail.code)
P=z.Concat(low(tail.expected_top),low(tr[1]),low(tm[-0x180]),low(tm[-0x150]));D=bridge['duration']
rows=[]
def prove(name,claim):
 s=z.Solver();s.set(timeout=30000);s.add(z.Not(claim));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result),s.reason_unknown()))
 rows.append({'name':name,'result':str(result)})
prove('actual overflow continuation guard',actual['guard']==z.ULT(z.Extract(127,64,P),D))
pairs=[(route['q'],z.Extract(63,0,P)),(route['h'],z.Extract(127,64,P)),(route['d'],D),(route['saved'],rr[3])]
for label,value in [('upper_hhi',rr[8]),('upper_hlo',rr[0]),('upper_dhi',rr[2]),('upper_dlo',rr[4]),('upper_qlo',mm[-0x150]),('upper_qhi',mm[-0xa8])]:pairs.append((z.BitVec(label,32),high(value)))
pairs.append((z.BitVec('deferred_flag',64),mm[-0x160]))
for i,value in enumerate(rr):
 if z.is_bv(value):pairs.append((z.BitVec('route_r'+str(i),64),value))
sub=lambda v:z.substitute(v,*pairs) if z.is_bv(v) else v
checks=[z.BoolVal(a==b) if isinstance(a,tuple) else a==sub(b) for a,b in zip(rr,route['r'])]+[mm[k]==sub(v) for k,v in route['mem'].items()]
prove('complete modeled route entry registers and declared memory',z.And(*checks))
# The nonzero-high branch builds four complete div16 inputs.
captured={};caller['run'](0x2500,capture=captured)
st=route['m'].execute(tail.text,tail.address,0x2490,0x2500,rr,{},lambda *_:None,mm);r,mem=st['registers'],st['memory']
pairs=[(caller['q'],z.Extract(63,0,P)),(caller['h'],z.Extract(127,64,P)),(caller['d'],D),(caller['saved'],rr[3])]
for label,value in [('raw_dhi_upper',r[2]),('raw_dlo_upper',r[4]),('raw_hhi_upper',r[8]),('raw_hlo_upper',r[0]),('raw_qlo_upper',mem[-0x150]),('raw_qhi_upper',mem[-0xa8])]:pairs.append((z.BitVec(label,32),high(value)))
pairs.append((z.BitVec('deferred_flag',64),mem[-0x160]))
for i,value in enumerate(r):
 if z.is_bv(value):pairs.append((z.BitVec('caller'+str(i),64),value))
checks=[z.BoolVal(a==b) if isinstance(a,tuple) else a==sub(b) for a,b in zip(r,captured['registers'])]
for offset,value in captured['words'].items():
 slot=offset if offset%8==0 else offset-4;actualword=low(mem[slot]) if offset%8==0 else high(mem[slot]);checks.append(actualword==sub(value))
prove('complete restoring caller registers and input words',z.And(*checks))
# The 128/32 branch must receive the actual clock words and dividend limbs,
# rather than an independently assumed duration/temporary-frame interpretation.
small=fresh('check-small-quotient.py','caller-entry-small-prerequisite.log')
st=route['m'].execute(tail.text,tail.address,0x2490,0x2680,rr,{},lambda *_:None,mm);r,mem=st['registers'],st['memory']
pairs=[(small['q'],z.Extract(63,0,P)),(small['h'],z.Extract(95,64,P)),(small['start'],tail.startlo),(small['end'],tail.endlo),(small['saved'],rr[3]),(small['raw_d'],high(r[4])),(small['raw_q'],high(mem[-0x150])),(z.BitVec('small_flag',64),mem[-0x160])]
for i,value in enumerate(r):
 if z.is_bv(value):pairs.append((z.BitVec('small_r'+str(i),64),value))
checks=[z.BoolVal(a==b) if isinstance(a,tuple) else a==sub(b) for a,b in zip(r,small['regs'])]+[mem[k]==sub(v) for k,v in small['mem'].items()]
prove('complete small caller registers and input words',z.Implies(st['guard'],z.And(*checks)))
prove('valid small route supplies bounded dividend and nonzero clock difference',z.Implies(z.And(actual['guard'],st['guard'],D!=0),z.And(z.Extract(127,96,P)==0,z.ULT(z.Extract(95,64,P),z.Extract(31,0,D)),tail.startlo!=tail.endlo)))
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest();pr=bridge['run']/'bridge.json';rp=base/'call-routes-report.json';cp=base/'caller-calls-report.json';sp=base/'small-quotient-report.json'
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':rows,'reports':{str(p):sha(p) for p in [pr,rp,cp,sp]},'inputHashes':{str(p):sha(p) for p in [Path(__file__),base/'link-denominator.py',base/'check-call-routes.py',base/'check-caller-calls.py',base/'check-small-quotient.py']},'scope':'Actual product/tail/overflow state supplies complete current division router and restoring caller inputs. Native input preservation is checked by the router contract. Restricted models, source layout, valid disjoint ABI memory and CALL preservation remain trusted; full quotient and whole-handler claims require separate composition.'}
(base/'caller-entry-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'claims':len(rows),'productPrerequisite':str(pr)}))
