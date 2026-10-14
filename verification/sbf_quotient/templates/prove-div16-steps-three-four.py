"""Next two div16 steps with live-machine and mathematical interface checks."""
from pathlib import Path
import contextlib,hashlib,json,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
prior=base/'prove-div16-first-two.py';ns={'__file__':str(prior.resolve())}
with (base/'div16-first-two-prerequisite.log').open('w') as log,contextlib.redirect_stdout(log):exec(compile(prior.read_text(),str(prior),'exec'),ns)
z=ns['z'];m=ns['m'];cfg=ns['cfg'];text=ns['text'];address=ns['address'];low=ns['low'];ext=ns['ext'];rows=[];contexts={}
def prove(name,claim):
 s=z.Solver();s.set(timeout=10000);s.add(z.Not(claim));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result),s.reason_unknown(),str(s.model()) if result==z.sat else ''))
 rows.append({'name':name,'result':str(result)})
def live(entry,stop):
 ins,succ,cone=cfg.acyclic_cone(text,address,entry,stop);out={stop:set()}
 for at in sorted(cone-{stop},reverse=True):
  op,ds,off,imm=ins[at];dst=ds&15;src=ds>>4;reads=set();writes=set()
  if op in cfg.BRANCHES:
   if op!=5:reads.add(dst)
   if op&8:reads.add(src)
  elif op in (0x79,0xbf):reads.add(src);writes.add(dst)
  elif op==0x7b:reads.update([dst,src])
  elif op in (0xb7,0x18):writes.add(dst)
  elif op in (0x67,0x77,0x57,0x47):reads.add(dst);writes.add(dst)
  elif op in (0x1f,0x5f,0x4f):reads.update([dst,src]);writes.add(dst)
  else:raise RuntimeError('unknown opcode '+hex(op))
  after=set().union(*(out[t] for t in succ[at] if t in cone));out[at]=(after-writes)|reads
 return out[entry]
previous={'state':ns['second'],'q':ns['qout'],'r':ns['rout'],'d':ns['din']}
interfaces=[]
for step,entry,stop in [(3,0x4a30,0x4c00),(4,0x4c00,0x4dc0)]:
 lo,hi,partial,carry,qlow,oldq=z.BitVecs(' '.join('step'+str(step)+'_'+n for n in ['lo','hi','partial','carry','qlow','oldq']),64);dh,dl=z.BitVecs('step'+str(step)+'_dh step'+str(step)+'_dl',32)
 regs=[z.BitVec('s'+str(step)+'_r'+str(i),64) for i in range(10)]+[('stack',0)];regs[2]=ext(dh);regs[4]=partial;regs[5]=lo
 memory={-48:ext(dh),-56:ext(dl),-80:('output',0)}
 if step==3:
  regs[6]=carry;regs[7]=qlow;regs[9]=hi;memory[-64]=oldq
  qhi=low((((partial<<1)|(carry&1))<<1)|(z.LShR(oldq,31)&1))
  bindings=[(lo,5),(hi,9),(partial,4),(carry,6),(qlow,7),(oldq,-64)]
 else:
  regs[7]=oldq;regs[8]=hi;memory[-64]=carry;memory[-72]=qlow
  qhi=low((((partial<<1)|(carry&1))<<1)|(z.LShR(oldq,31)&1))
  bindings=[(lo,5),(hi,8),(partial,4),(carry,-64),(qlow,-72),(oldq,7)]
 q=z.Concat(qhi,low(qlow));r=z.Concat(low(hi),low(lo));d=z.Concat(dh,dl);wantq,wantr=ns['next_step'](q,r,d)
 state=m.execute(text,address,entry,stop,regs,{'output':40},lambda *_:None,memory);o=state['registers'];om=state['memory']
 if step==3:qout=z.Concat(low((((o[4]<<1)|(om[-64]&1))<<1)|(z.LShR(o[7],31)&1)),low(om[-72]));rout=z.Concat(low(o[8]),low(o[5]))
 else:qout=z.Concat(low((((o[4]<<1)|(o[6]&1))<<1)|(z.LShR(om[-72],31)&1)),low(o[7]));rout=z.Concat(low(o[9]),low(o[5]))
 prove('step '+str(step)+' quotient remainder guard',z.And(qout==wantq,rout==wantr,state['guard']))
 prove('step '+str(step)+' preserved divisor',z.And(o[2]==ext(dh),om[-48]==ext(dh),om[-56]==ext(dl)))
 if om[-80]!=('output',0):raise RuntimeError('output frame lost')
 pr=previous['state']['registers'];pm=previous['state']['memory'];pairs=[(a,pr[k] if k>=0 else pm[k]) for a,k in bindings]+[(dh,low(pm[-48])),(dl,low(pm[-56]))]
 sub=lambda v:z.substitute(v,*pairs) if z.is_bv(v) else v
 def eq(a,b):return z.BoolVal(a==b) if isinstance(a,tuple) else a==b
 needed=live(entry,stop)
 prove('step '+str(step)+' actual live registers and complete memory',z.And(*[eq(pr[k],sub(regs[k])) for k in needed],*[eq(pm[k],sub(v)) for k,v in memory.items()]))
 prove('step '+str(step)+' mathematical input composition',z.And(sub(q)==previous['q'],sub(r)==previous['r'],sub(d)==previous['d']))
 interfaces.append({'step':step,'liveRegisters':sorted(needed),'instructions':state['coneInstructions']})
 contexts[step]={'state':state,'q':qout,'r':rout,'d':d};previous=contexts[step]
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest();prior_report=base/'div16-first-two-report.json'
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':rows,'interfaces':interfaces,'prerequisite':str(prior_report),'prerequisiteSha256':sha(prior_report),'inputHashes':{str(p):sha(p) for p in [Path(__file__),prior,ns['elf'],repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py']},'scope':'First four inlined div16 steps compose via live-register/full-memory checks and mathematical q/r/d interpretations. Next eight inline steps and full nested-call theorem unfinished.'}
(base/'div16-steps-three-four-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'claims':len(rows),'interfaces':interfaces}))
