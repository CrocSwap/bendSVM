"""Conditional checks of actual post-quotient vesting guards and amount limbs."""
from pathlib import Path
import hashlib,json,struct,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
import z3 as z
import sbf_leaf as m
from sbf_elf import text_section
if not __debug__:raise RuntimeError('assertions required')
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes())
q,total,claimed=z.BitVecs('vested total claimed',64)
lo=lambda v:z.ZeroExt(32,z.Extract(31,0,v));hi=lambda v:z.ZeroExt(32,z.Extract(63,32,v))
regs=[z.BitVec('payout_r'+str(i),64) for i in range(10)]+[('stack',0)]
mem={-0xa8:q,-0xb8:lo(total),-0xc0:hi(total),-0x128:lo(claimed),-0x130:hi(claimed),-0x120:z.BitVec('opaque110',64),-0x158:z.BitVec('opaquee8',64)}
rows=[];states={}
def prove(name,claim):
 s=z.Solver();s.set(timeout=10000);s.add(z.Not(claim));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result),s.reason_unknown(),str(s.model()) if result==z.sat else ''))
 rows.append({'name':name,'result':str(result)})
guards={'over-total':z.UGT(q,total),'under-claimed':z.And(z.ULE(q,total),z.ULT(q,claimed)),'zero-payout':z.And(z.ULE(q,total),q==claimed),'transfer':z.And(z.ULE(q,total),z.UGT(q,claimed))}
for name,stop in [('over-total',0x2a28),('under-claimed',0x2a38),('zero-payout',0x2a48),('transfer',0x28d8)]:
 state=m.execute(text,address,0x2748,stop,regs,{},lambda *_:None,mem);states[name]=state
 prove(name+' exact reachability',state['guard']==guards[name])
 prove(name+' unchanged input stack',z.And(*(state['memory'][off]==v for off,v in mem.items())))
 s=z.Solver();s.add(state['guard']);result=s.check()
 if result!=z.sat:raise RuntimeError('vacuous '+name)
 rows.append({'name':name+' nonvacuity','result':'sat','witness':str(s.model())})
success=states['transfer'];r=success['registers'];amount=z.Concat(z.Extract(31,0,r[4]),z.Extract(31,0,r[1]))
prove('transfer exact difference limbs',z.Implies(success['guard'],z.And(amount==q-claimed,r[4]==hi(q-claimed),r[1]==lo(q-claimed))))
prove('context preserved on transfer',success['registers'][3]==regs[3])
prove('four-way exhaustive disjoint partition',z.And(z.Or(*guards.values()),*(z.Not(z.And(a,b)) for i,a in enumerate(guards.values()) for j,b in enumerate(guards.values()) if i<j)))
# Error materialization begins at each corresponding branch target.
for name,start,code in [('over-total',0x2a28,4),('under-claimed',0x2a38,5),('zero-payout',0x2a48,6)]:
 state=states[name];tail=m.execute(text,address,start,0x2a50,state['registers'],{},lambda *_:None,state['memory'])
 prove(name+' error code',z.And(tail['guard'],tail['registers'][1]==code))
# Actual byte faults must invalidate intended guards or arithmetic under reachable inputs.
faults=[]
for name,at,opcode,stop,want in [
 ('total-low-strict',0x2780,0x2d,0x2a28,guards['over-total']),
 ('claimed-high-equality',0x2820,0x3d,0x2a38,guards['under-claimed']),
 ('zero-payout-reversed',0x28d0,0x55,0x2a48,guards['zero-payout']),
 ('missing-borrow',0x2870,0x4f,0x28d8,None),
]:
 bad=bytearray(text);bad[at-address]=opcode
 state=m.execute(bytes(bad),address,0x2748,stop,regs,{},lambda *_:None,mem)
 wrong=state['guard']!=want if want is not None else z.And(state['guard'],z.Concat(z.Extract(31,0,state['registers'][4]),z.Extract(31,0,state['registers'][1]))!=q-claimed)
 s=z.Solver();s.set(timeout=10000);s.add(wrong);result=s.check()
 if result!=z.sat:raise RuntimeError(('missed fault',name,str(result)))
 witness=s.model();faults.append({'name':name,'address':at,'result':str(result),'input':{str(v):witness.eval(v,model_completion=True).as_long() for v in [q,total,claimed]}})
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':rows,'faults':faults,'instructions':{k:v['coneInstructions'] for k,v in states.items()},'inputHashes':{str(p):sha(p) for p in [Path(__file__),elf,repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py',repo/'examples/vesting/vesting.bend']},'scope':'Actual post-quotient branch conditions, error codes 4/5/6 and transfer amount limbs under explicit U32 total/claimed stack bindings and arbitrary u64 vested value. Guards partition all scalar inputs. Does not prove original entrance bindings, quotient meaning, output record/effects or commit; restricted machine model/Z3/valid frame remain trusted.'}
out=base/'payout-guards-report.json';out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'claims':len(rows),'faults':faults,'report':str(out)}))
