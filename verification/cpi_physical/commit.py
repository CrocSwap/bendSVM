"""Instantiate fresh array-store theorems at every actual parsed commit byte.

The result is conditional on physical precommit managed-byte projection and
bounded disjoint account spans. Caller/loader/helper proofs supply these premises.
The finite induction driver and parsed event extraction remain trusted.
"""
import z3 as z
import sys
sys.path.insert(0,'verification')
import multi_adapter_contract as m
from cpi_physical.typed_dag import Fingerprints

def analyse(w,starts=None,precommit=None,folder=None):
 fingerprint=Fingerprints()
 v=lambda n:z.BitVecVal(n,64);v32=lambda n:z.BitVecVal(n,32)
 memory=z.Array('induction_memory',z.BitVecSort(64),z.BitVecSort(8))
 a,b,alen,blen,write,read=z.BitVecs('induction_a induction_b induction_alen induction_blen induction_write induction_read',64)
 value=z.BitVec('induction_value',8)
 same=z.Select(z.Store(memory,a+write,value),a+read)==z.If(read==write,value,z.Select(memory,a+read))
 domain=z.And(z.ULE(a,v((1<<64)-1-10*1024*1024)),z.ULE(b,v((1<<64)-1-10*1024*1024)),z.ULE(alen,v(10*1024*1024)),z.ULE(blen,v(10*1024*1024)),z.ULT(write,alen),z.ULT(read,blen),z.Or(z.ULE(a+alen,b),z.ULE(b+blen,a)))
 other=z.Select(z.Store(memory,a+write,value),b+read)==z.Select(memory,b+read)
 proofs=[]
 for number,claim in enumerate((same,z.Implies(domain,other))):
  solver=z.Solver();solver.set(timeout=30000);solver.add(z.Not(claim));answer=solver.check();assert answer==z.unsat,(str(answer),solver.reason_unknown())
  assert folder is not None
  path=folder/('physical-store-theorem-'+str(number)+'.smt2');path.write_text(solver.to_smt2())
  proofs.append({'name':'physical-store-theorem-'+str(number),'result':'unsat','query':str(path),'querySha256':__import__('hashlib').sha256(path.read_bytes()).hexdigest()})
 if starts is None:starts=[z.BitVec('physical_start_'+str(i),64) for i in range(len(w.D))]
 assert len(starts)==len(w.D) and all(x.sort()==z.BitVecSort(64) for x in starts)
 off=z.BitVec('physical_read_offset',32);read64=z.ZeroExt(32,off)
 def array(values):
  result=z.K(z.BitVecSort(32),z.BitVecVal(0,8))
  for j,x in enumerate(values):result=z.Store(result,v32(j),x)
  return result
 seen={};rows=[];steps=0;instances=0
 for pathno,path in enumerate(w.paths):
  writes=[e for e in path.events if e.kind=='write']
  signature=tuple((e.account,e.offset,tuple(fingerprint(x) for x in e.data)) for e in writes)
  if signature in seen:
   previous,previous_writes=seen[signature]
   assert len(writes)==len(previous_writes) and all(a.account==b.account and a.offset==b.offset and len(a.data)==len(b.data) and all(z.eq(x,y) for x,y in zip(a.data,b.data)) for a,b in zip(writes,previous_writes)), 'commit cache AST mismatch'
   rows.append({'path':pathno,'reuse':previous,'writeSignature':signature});continue
  seen[signature]=(pathno,writes)
  physical=precommit if precommit is not None else z.Array('physical_precommit_'+str(pathno),z.BitVecSort(64),z.BitVecSort(8))
  projected=[array(d) for d in w.D];event_steps=[]
  for eventno,e in enumerate(writes):
   assert 0<=e.account<len(w.D) and 0<=e.offset and e.offset+len(e.data)<=len(w.D[e.account])
   for k,x in enumerate(e.data):
    i=e.account;at=e.offset+k;assert x.sort()==z.BitVecSort(8)
    after=z.Store(physical,starts[i]+v(at),x)
    for j,values in enumerate(w.D):
     if not values:continue
     pairs=[(memory,physical),(a,starts[i]),(b,starts[j]),(alen,v(len(w.D[i]))),(blen,v(len(values))),(write,v(at)),(read,read64),(value,x)]
     theorem=z.substitute(same if i==j else other,*pairs)
     lhs=z.Select(after,starts[j]+read64)
     rhs=z.If(z.BitVecRef.__eq__(read64,v(at)),x,z.Select(physical,starts[j]+read64)) if i==j else z.Select(physical,starts[j]+read64)
     assert z.eq(theorem,lhs==rhs),(i,j,theorem.sexpr(),(lhs==rhs).sexpr())
     # Every bounded-span premise is supplied by the decoded-span/precommit
     # contract; concrete write/width side conditions are checked here.
     assert 0<=at<len(w.D[i])<=10*1024*1024 and len(values)<=10*1024*1024
     if i==j:
      # BV32 read index zero extension preserves equality with this actual
      # bounded constant byte offset. Fresh solver checks this bridge once per
      # distinct offset, independent of the growing physical memory expression.
      scalar=z.simplify((read64==v(at))==(off==v32(at)))
      assert z.is_true(scalar)
     instances+=1
    projected[i]=z.Store(projected[i],v32(at),x);physical=after;steps+=1
    event_steps.append({'event':eventno,'account':i,'offset':at})
  for i in range(len(w.D)):
   final=m.final_data(w,path,i);assert final is not None
   for j,x in enumerate(final):assert z.eq(z.simplify(z.Select(projected[i],v32(j))),z.simplify(x))
  rows.append({'path':pathno,'steps':event_steps,'finalProjection':'exact-byte-ast','physicalStores':len(event_steps),'writeSignature':signature})
 assert steps>0
 return {'precommitMemoryFingerprint':None if precommit is None else fingerprint(precommit),'paths':rows,'byteSteps':steps,'storeTheoremInstances':instances,'freshStoreTheorems':2,'storeProofs':proofs,'scope':'Finite induction instantiates fresh physical Store theorems at each actual parsed write byte and matches final_data. Requires derived disjoint spans and physical precommit managed-byte equality; does not establish these premises itself.'}
