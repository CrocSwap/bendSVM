"""Complete the arithmetic identity behind the conditional 73-instruction slice."""
from pathlib import Path
import hashlib,json,subprocess,sys
import z3 as z
if not __debug__:raise RuntimeError('assertions required')
base=Path(__file__).resolve().parent
if z.get_version_string()!='5.1.0':raise RuntimeError('solver pin')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
files=[Path(__file__).resolve().parents[2]/'verification/sbf_elf.py',Path(__file__).resolve().parents[2]/'verification/sbf_paths.py',Path(__file__).resolve().parents[2]/'verification/sbf_cfg.py',Path(__file__).resolve().parents[2]/'verification/sbf_machine.py',Path(__file__),base/'compose.py',base/'check.py',base.parent/'sbf-slice-probe/check.py',base.parent/'sbf-slice-probe/vesting.so']
bindings={str(p):sha(p) for p in files}
p=subprocess.run([sys.executable,str(base/'compose.py')],capture_output=True,text=True,timeout=120)
(base/'product-prerequisite.log').write_text(p.stdout+p.stderr)
if p.returncode:raise RuntimeError('fresh composition failed')
composition=json.loads((base/'composition-report.json').read_text())
if not composition['passed'] or composition['boundary']['result']!='unsat':raise RuntimeError('missing fresh composition')
rows=[]
def prove(name,claim,want=z.unsat):
 s=z.Solver();s.set(timeout=30000);s.add(z.Not(claim));result=s.check()
 if result!=want:raise RuntimeError((name,str(result),s.reason_unknown()))
 row={'name':name,'result':str(result)}
 if result==z.sat:row['witness']=str(s.model())
 rows.append(row)
# Distributivity in the actual modulo-2^128 output domain, independent of bounds.
x,y,u,v=z.BitVecs('ring_x ring_y ring_u ring_v',128);B=2**32
expanded=x*u+(y*u+x*v)*B+y*v*B**2
normal=z.simplify((x+y*B)*(u+v*B)-expanded,som=True)
prove('128-bit distributive expansion',normal==0)
a0,a1,b0,b1=z.BitVecs('bridge_alo bridge_ahi bridge_blo bridge_bhi',32)
wide=lambda a:z.ZeroExt(96,a)
small=lambda a:z.ZeroExt(32,a)
wide_products=[];small_products=[]
for name,a,b in [('p00',a0,b0),('p10',a1,b0),('p01',a0,b1),('p11',a1,b1)]:
 wp=wide(a)*wide(b);sp=z.ZeroExt(64,small(a)*small(b))
 prove(name+' exact widening',wp==sp)
 wide_products.append(wp);small_products.append(sp)
for name,lo,hi in [('a',a0,a1),('b',b0,b1)]:
 prove(name+' packed input',z.ZeroExt(64,z.Concat(hi,lo))==wide(lo)+wide(hi)*B)
instance=z.substitute(expanded,(x,wide(a0)),(y,wide(a1)),(u,wide(b0)),(v,wide(b1)))
rewritten=z.substitute(instance,*zip(wide_products,small_products))
p00,p10,p01,p11=small_products
partial_sum=p00+(p10<<32)+(p01<<32)+(p11<<64)
q0,q1,q2,q3=z.BitVecs('sum_q0 sum_q1 sum_q2 sum_q3',128)
generic_left=q0+(q1+q2)*B+q3*B**2
generic_right=q0+(q1<<32)+(q2<<32)+(q3<<64)
prove('universal carry sum reassociation',generic_left==generic_right)
substitution=list(zip([q0,q1,q2,q3],small_products))
if not z.eq(z.substitute(generic_left,*substitution),rewritten):raise RuntimeError('left sum substitution')
if not z.eq(z.substitute(generic_right,*substitution),partial_sum):raise RuntimeError('right sum substitution')
# Fault controls use concrete limbs to avoid testing solver resource limits.
fault=z.substitute(rewritten-p00,(a0,z.BitVecVal(3,32)),(a1,z.BitVecVal(5,32)),(b0,z.BitVecVal(7,32)),(b1,z.BitVecVal(11,32)))
correct=z.substitute(partial_sum,(a0,z.BitVecVal(3,32)),(a1,z.BitVecVal(5,32)),(b0,z.BitVecVal(7,32)),(b1,z.BitVecVal(11,32)))
prove('omitted-low-product control',fault==correct,z.sat)
if bindings!={str(p):sha(p) for p in files}:raise RuntimeError('input drift')
report={'passed':True,'exploratory':True,'endToEndVerified':False,'inputHashes':bindings,'compositionSha256':sha(base/'composition-report.json'),'prerequisiteLogSha256':sha(base/'product-prerequisite.log'),'claims':rows,'scope':'Fresh conditional78instruction composition plus discharged bitvector widening, packing and ring identities establishes reconstructed distributed128bit output equals zero-extended64bit inputs multiplied. Original entry assumptions remain: limb/register/stack correspondence and valid memory. Does not establish source-to-cutpoint correspondence, handler reachability, actual later top-limb accumulation or final handler output. Z3 simplifier/solver and restricted machine semantics remain trusted.'}
(base/'product-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'claims':len(rows),'scope':report['scope']}))
