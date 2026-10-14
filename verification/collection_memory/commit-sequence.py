if not __debug__:raise RuntimeError('memory proof assertions required')
from pathlib import Path
import os
OUT=Path(os.environ.get("MEMORY_RUN_DIR","build/collection-memory"))
import runpy,json,hashlib
import z3 as z
m=(globals().get('qualified_commit') or runpy.run_path('verification/collection_memory/commit-frame.py',run_name='__main__'));n=m['n'];v=n['v'];env=dict(m['env']);base=m['base'];wire=n['wire'];pre=m['pre'];offset=m['offset'];count=m['count'];size=env['data_size']
encoded=z.Array('encoded_scratch',z.BitVecSort(64),z.BitVecSort(8));header=z.Array('schema_header',z.BitVecSort(64),z.BitVecSort(8));j=z.BitVec('commit_byte_index',64);k=z.BitVec('array_view_index',64)
key=z.Lambda(k,z.Select(wire,n['starts'][0]+v(8)+k));old=z.Lambda(k,z.Select(wire,base+k))
env.update(byte_index=j,post_data_byte=z.BitVec('post_byte',8),header=header,state_key=key,encoded=encoded,old_data=old)
expected=m['cc'].term(m['doc']['byteFrame']['expected'],env)
rows=[]
def check(name,condition,extra=(),expected_status=z.unsat):
 s=z.Solver();s.set(timeout=60000);s.add(*n['premises'],pre,*extra,z.Not(condition));r=s.check();print(name,r,flush=True);assert r==expected_status,(name,r,s.reason_unknown());rows.append({'name':name,'result':str(r)});return s
check('bounded-record-unroll-complete',z.ULE(count,v(8)))
# The matched helper syntax has <=8 record stores followed by20header,4length,
# and32key stores. Header/scratch are separate stable objects. State-key reads
# use the original serialized key; stability is an explicit composition premise.
def execute(written,shift=0):
 after=wire
 for i in range(written*4):after=z.Store(after,base+offset+v(i+shift),z.Select(encoded,v(i)))
 for i in range(20):after=z.Store(after,base+v(i),z.Select(header,v(i)))
 for i in range(4):after=z.Store(after,base+v(20+i),z.Extract(i*8+7,i*8,env['next_length']))
 for i in range(32):after=z.Store(after,base+v(24+i),z.Select(key,v(i)))
 return after
for written in range(3):
 after=execute(written);case=[env['written']==written]
 regions=[('header',z.ULT(j,v(20))),('length',z.And(z.UGE(j,v(20)),z.ULT(j,v(24)))),('key',z.And(z.UGE(j,v(24)),z.ULT(j,v(56)))),('records',z.And(z.UGE(j,offset),z.ULT(j,offset+count))),('unchanged',z.And(z.UGE(j,v(56)),z.Or(z.ULT(j,offset),z.UGE(j,offset+count))))]
 for name,region in regions:
  check('written-'+str(written)+'-'+name,z.Select(after,base+j)==expected,[*case,z.ULT(j,size),region])
 read=z.BitVec('outside_read',64)
 outside=z.Or(z.ULT(read,base),z.UGE(read,base+size))
 targets=[base+offset+v(i) for i in range(written*4)]+[base+v(i) for i in range(56)]
 disjoint=z.And(*[read!=target for target in targets])
 check('written-'+str(written)+'-outside-addresses-disjoint',disjoint,[*case,outside])
 check('written-'+str(written)+'-global-frame',z.Select(after,read)==z.Select(wire,read),[*case,outside,disjoint])
 s=z.Solver();s.add(*n['premises'],pre,*case);assert s.check()==z.sat
# Wrong record destination must disagree with the specified complete post-state.
fault=execute(1,shift=1)
s=check('shifted-record-store-control',z.Select(fault,base+j)==expected,[env['written']==1,z.ULT(j,size)],z.sat)
(OUT/'commit-sequence.json').write_text(json.dumps({'passed':True,'claims':rows,'writtenCountWitnesses':[0,1,2],'contractInterfaceHash':m['cc'].CONTRACT_INTERFACE_HASH,'scope':'Bounded byte-store sequence matching the parsed commit families, fixed stride4 and scratch8, compared with shared byteFrame under explicit valid-plan/contiguous-layout/stable scratch-header-key assumptions. Local descriptor store, source-key stability induction, pointer provenance, VM mapping and emitted SBF remain outside this experiment.'},indent=2)+'\n')
