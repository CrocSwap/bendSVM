"""Compositional checks for the remaining eight inline div16 steps."""
from pathlib import Path
import contextlib,hashlib,json,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
prior=base/'prove-div16-steps-three-four.py';ns={'__file__':str(prior.resolve())}
with (base/'div16-four-prerequisite.log').open('w') as log,contextlib.redirect_stdout(log):exec(compile(prior.read_text(),str(prior),'exec'),ns)
z=ns['z'];m=ns['m'];text=ns['text'];address=ns['address'];low=ns['low'];ext=ns['ext'];rows=[];interfaces=[];contexts={}
def prove(name,claim):
 s=z.Solver();s.set(timeout=10000);s.add(z.Not(claim));r=s.check()
 if r!=z.unsat:raise RuntimeError((name,str(r),s.reason_unknown(),str(s.model()) if r==z.sat else ''))
 rows.append({'name':name,'result':str(r)})
# locations: carry, previous quotient-low, current quotient-low, remainder-high,
# divisor-high register; optional known divisor-low register. Negative=stack.
layouts=[(6,-72,7,9,2,None),(0,7,-64,8,2,None),(7,-64,-72,9,2,6),(0,-72,7,8,2,None),(0,7,-72,9,2,None),(7,6,-64,8,2,None),(6,-64,-72,9,7,None),(6,-72,2,8,3,None)]
cuts=[0x4dc0,0x4f80,0x5148,0x52e8,0x54b0,0x5688,0x5848,0x59e8,0x5bc0]
def get(regs,mem,k):return regs[k] if k>=0 else mem[k]
def interpret(regs,mem,layout):
 c,p,q,h,_,_=layout
 high=low((((regs[4]<<1)|(get(regs,mem,c)&1))<<1)|(z.LShR(get(regs,mem,p),31)&1))
 return z.Concat(high,low(get(regs,mem,q))),z.Concat(low(regs[h]),low(regs[5]))
previous=ns['contexts'][4]
for index,layout in enumerate(layouts):
 step=index+5;entry,stop=cuts[index:index+2];carry,prevq,qlow,remhi,dhreg,dlreg=layout
 regs=[z.BitVec('s'+str(step)+'_r'+str(i),64) for i in range(10)]+[('stack',0)]
 dh,dl=z.BitVecs('s'+str(step)+'_dh s'+str(step)+'_dl',32);memory={-48:ext(dh),-56:ext(dl),-80:('output',0)};regs[dhreg]=ext(dh)
 if dlreg is not None:regs[dlreg]=ext(dl)
 for k in [carry,prevq,qlow]:
  if k<0:memory[k]=z.BitVec('s'+str(step)+'_mem'+str(-k),64)
 q,r=interpret(regs,memory,layout);d=z.Concat(dh,dl);wantq,wantr=ns['ns']['next_step'](q,r,d)
 state=m.execute(text,address,entry,stop,regs,{'output':40},lambda *_:None,memory);o=state['registers'];om=state['memory']
 if step<12:qout,rout=interpret(o,om,layouts[index+1])
 else:qout=z.Concat(low((o[4]<<1)|(z.LShR(o[2],31)&1)),low(o[1]));rout=z.Concat(low(o[7]),low(o[5]))
 prove('step '+str(step)+' quotient remainder guard',z.And(qout==wantq,rout==wantr,state['guard']))
 prove('step '+str(step)+' retained divisor',z.And(om[-48]==ext(dh),om[-56]==ext(dl)))
 if om[-80]!=('output',0):raise RuntimeError('lost pointer frame')
 pr=previous['state']['registers'];pm=previous['state']['memory'];pairs=[(dh,low(pm[-48])),(dl,low(pm[-56]))]
 # Substitution instantiates all independent scalar inputs, including dead ones;
 # liveness determines which machine equalities are proof obligations.
 for k,v in enumerate(regs):
  if z.is_const(v) and z.is_bv(v) and z.is_bv(pr[k]):pairs.append((v,pr[k]))
 for k,v in memory.items():
  if z.is_const(v) and z.is_bv(v):pairs.append((v,pm[k]))
 sub=lambda v:z.substitute(v,*pairs) if z.is_bv(v) else v
 def eq(a,b):return z.BoolVal(a==b) if isinstance(a,tuple) else a==b
 needed=ns['live'](entry,stop)
 prove('step '+str(step)+' actual live registers and complete memory',z.And(*[eq(pr[k],sub(regs[k])) for k in needed],*[eq(pm[k],sub(v)) for k,v in memory.items()]))
 prove('step '+str(step)+' mathematical input composition',z.And(sub(q)==previous['q'],sub(r)==previous['r'],sub(d)==previous['d']))
 interfaces.append({'step':step,'liveRegisters':sorted(needed),'instructions':state['coneInstructions']})
 contexts[step]={'state':state,'q':qout,'r':rout,'d':d};previous=contexts[step]
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest();pr=base/'div16-steps-three-four-report.json'
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':rows,'interfaces':interfaces,'prerequisite':str(pr),'prerequisiteSha256':sha(pr),'inputHashes':{str(p):sha(p) for p in [Path(__file__),prior,ns['ns']['elf'],repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py']},'scope':'All twelve actual inline div16 steps compose through checked machine and q/r/d interfaces. Stack construction and nested div4 call remain to compose; not full quotient or caller verification.'}
(base/'div16-rest-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'claims':len(rows),'interfaces':interfaces}))
