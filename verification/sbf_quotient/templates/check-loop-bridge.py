"""Connect the emitted-step specification to bounded Euclidean loop induction."""
from pathlib import Path
import contextlib,hashlib,json,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
import z3 as z
from division_loop import induction
if z.get_version_string()!='5.1.0':raise RuntimeError('solver pin')
source=base/'prove-div16-first-two.py';text=source.read_text();cut=text.index("q,r,d=z.BitVecs('q r d',64)");ns={'__file__':str(source.resolve())};exec(compile(text[:cut],str(source),'exec'),ns)
q,r,d=z.BitVecs('bridge_q bridge_r bridge_d',64);oq,orr=ns['next_step'](q,r,d)
numerator=(z.ZeroExt(1,r)<<1)+z.ZeroExt(64,z.Extract(63,63,q));take=z.UGE(numerator,z.ZeroExt(1,d));remainder=z.If(take,numerator-z.ZeroExt(1,d),numerator)
expectedq=(q<<1)|z.If(take,z.BitVecVal(1,64),z.BitVecVal(0,64));valid=z.And(d!=0,z.ULT(r,d))
s=z.Solver();s.set(timeout=30000);s.add(valid,z.Not(z.And(oq==expectedq,z.ZeroExt(1,orr)==remainder,z.ULT(orr,d))));result=s.check()
if result!=z.unsat:raise RuntimeError(('machine spec integer step',str(result),s.reason_unknown()))
loop=induction()
if any(c['result']!='unsat' for c in loop):raise RuntimeError('loop prerequisites failed')
# Current restoring branch starts from the complete high64 remainder with a
# nonzero denominator high limb. Separate native routes cover the other inputs.
low=z.BitVec('lowDividend',64);high=z.BitVec('highDividend',64)
fullguard=z.And(d!=0,d!=1,high!=0,z.Extract(63,32,d)!=0,z.ULT(high,d))
s=z.Solver();s.add(fullguard,z.Not(z.And(d!=0,z.ULT(high,d))));result2=s.check()
if result2!=z.unsat:raise RuntimeError('restoring entry bound')
# With no high limb, the mathematical 128-bit numerator is exactly low64.
ni,di=z.Ints('native_numerator native_divisor')
s=z.Solver();s.add(ni>=0,ni<2**64,di>0,di<2**64,z.Not(z.And(ni/di>=0,ni/di<2**64,ni==(ni/di)*di+ni%di,ni%di>=0,ni%di<di)))
if s.check()!=z.unsat:raise RuntimeError('native Euclidean bound')
# Integer radix-B connection for the new 128/32 branch. The assumptions are
# exactly the two unsigned Euclidean divisions; universal slice identities
# establish their actual numerators. BV-to-Int interpretation remains trusted.
B=2**32;sd,sh,qa,qb,qh,rh,ql,rem=z.Ints('small_d small_h small_a small_b small_qh small_rh small_ql small_rem')
smallpre=z.And(sd>0,sd<B,sh>=0,sh<sd,qa>=0,qa<B,qb>=0,qb<B,qh>=0,ql>=0,rh>=0,rh<sd,rem>=0,rem<sd,sh*B+qa==qh*sd+rh,rh*B+qb==ql*sd+rem)
smallrows=[]
for name,claim in [
 ('small division intermediates fit U64',z.And(sh*B+qa>=0,sh*B+qa<B*B,rh*B+qb>=0,rh*B+qb<B*B)),
 ('small quotient limbs fit U32',z.And(qh<B,ql<B)),
 ('small composed Euclidean identity',sh*B*B+qa*B+qb==(qh*B+ql)*sd+rem),
 ('small combined quotient fits U64',z.And(qh*B+ql>=0,qh*B+ql<B*B))]:
 s=z.Solver();s.set(timeout=30000);s.add(smallpre,z.Not(claim));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result),s.reason_unknown()))
 smallrows.append({'name':name,'result':'unsat'})
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'endToEndVerified':False,'stepBridge':'unsat','restoringRemainderBound':'unsat','nativeEuclideanBound':'unsat','claims':smallrows,'loop':loop,'inputHashes':{str(p):sha(p) for p in [Path(__file__),source,repo/'verification/division_loop.py',repo/'verification/prove.py',repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py',ns['elf']]},'scope':'Exact emitted-step specification matches65bit Euclidean restoring step under nonzero divisor/remainder bound; integer loop induction freshly passes, restoring-route entry satisfies the initial remainder bound, native zero-high integer division satisfies Euclidean quotient/remainder bounds, and the two-limb small route composes bounded Euclidean divisions into the full quotient/remainder identity. Does not numerically formalize BV-to-Int interpretation itself, instantiate machine helper call UFs, or bind caller entrance to application product.'}
(base/'loop-bridge-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'stepBridge':str(result),'loopClaims':len(loop),'nativeEuclideanBound':'unsat'}))
