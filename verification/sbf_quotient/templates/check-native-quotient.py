"""Current native quotient slice with fail-closed nonzero-divisor checks."""
from pathlib import Path
import hashlib,importlib.util,json,sys
import z3 as z
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
from sbf_elf import text_section
import sbf_leaf as m
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes())
q,d,saved=z.BitVecs('quotient_input divisor saved',64);raw=z.BitVec('unobserved_low_upper',32)
regs=[z.BitVec('r'+str(i),64) for i in range(10)]+[('stack',0)]
regs[5]=z.ZeroExt(32,z.Extract(31,0,d));regs[3]=saved
mem={-0x150:z.Concat(raw,z.Extract(31,0,q)),-0x170:z.ZeroExt(32,z.Extract(63,32,q))<<32,-0x140:z.ZeroExt(32,z.Extract(63,32,d))<<32,-0x160:z.BitVec('deferred_flag',64),-0x188:z.BitVec('sentinel',64)}
rows=[]
def solve(name,claim,want=z.unsat):
 s=z.Solver();s.set(timeout=30000);s.add(z.Not(claim));r=s.check();assert r==want,(name,r,s.reason_unknown());row={'name':name,'result':str(r)}
 if r==z.sat:row['witness']=str(s.model())
 rows.append(row)
def run(raw):return m.execute(raw,address,0x2610,0x2748,regs,{},lambda *_:None,mem,native_division=True)
state=run(text)
assert state['divisionChecks']==1
solve('native route guard equals nonzero divisor',state['guard']==(d!=0))
# Successful execution discharged the model's nonzero obligation at the DIV.
rows.append({'name':'actual executed division always nonzero','result':'unsat'})
solve('actual native quotient and preserved context/frame',z.Implies(state['guard'],z.And(state['memory'][-0xa8]==z.UDiv(q,d),state['registers'][3]==saved,*[state['memory'][k]==v for k,v in mem.items()])))
bad=bytearray(text);assert bad[0x2660-address]==0x3f;bad[0x2660-address]=0x1f
fault=run(bytes(bad));solve('subtraction instead of division detected',z.Implies(fault['guard'],fault['memory'][-0xa8]==z.UDiv(q,d)),z.sat)
bad=bytearray(text);assert bad[0x2628-address]==0x15;bad[0x2628-address]=0x55
try:run(bytes(bad))
except ValueError as e:assert str(e)=='division nonzero obligation: sat'
else:raise RuntimeError('inverted zero guard accepted')
rows.append({'name':'inverted zero guard unsafe division detected','result':'refused','reason':'division nonzero obligation: sat'})
for label,byte,value in [('reserved immediate',4,1),('reserved offset',2,1),('frame source',1,0xa2)]:
 bad=bytearray(text);bad[0x2660-address+byte]=value
 try:run(bytes(bad))
 except ValueError as e:assert str(e)=='division fields'
 else:raise RuntimeError('accepted malformed division '+label)
 rows.append({'name':label,'result':'refused'})
files=[Path(__file__),elf,repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py']
out={'passed':True,'exploratory':True,'endToEndVerified':False,'range':[0x2610,0x2748],'claims':rows,'inputHashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files},'scope':'Actual native quotient slice under declared register/spill interpretation. The opt-in restricted interpreter discharges every nonzero-divisor obligation before producing a result. Unsigned DIV semantics, Z3 and valid disjoint frame memory remain trusted. Caller-entry binding and VM replay are separate prerequisites; no whole-handler claim.'}
(base/'native-quotient-report.json').write_text(json.dumps(out,indent=2)+'\n')

print(json.dumps({'passed':True,'claims':len(rows),'divisionChecks':state['divisionChecks']}))
