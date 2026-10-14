if not __debug__:raise RuntimeError('memory proof assertions required')
from pathlib import Path
import os
OUT=Path(os.environ.get("MEMORY_RUN_DIR","build/collection-memory"))
import runpy,json
import z3 as z
m=(globals().get('qualified_commit') or runpy.run_path('verification/collection_memory/commit-frame.py',run_name='__main__'));n=m['n'];v=n['v'];pre=m['pre'];wire=n['wire'];base=m['base'];size=m['size']
key_index=z.BitVec('source_key_index',64);key_base=n['starts'][0]+v(8);read=key_base+key_index;key_domain=z.ULT(key_index,v(32));current=z.Array('current_memory',z.BitVecSort(64),z.BitVecSort(8));target=z.BitVec('store_target',64);value=z.BitVec('store_value',8)
inside=z.And(z.UGE(target,base),z.ULT(target,base+size));after=z.Store(current,target,value);invariant=z.Select(current,read)==z.Select(wire,read);rows=[]
def check(name,condition,extra=(),wanted=z.unsat,premises=None):
 s=z.Solver();s.set(timeout=60000);s.add(*(n['premises'] if premises is None else premises),pre,*extra,z.Not(condition));r=s.check();print(name,r,flush=True);assert r==wanted,(name,r,s.reason_unknown());rows.append({'name':name,'result':str(r)});return s
check('source-key-span-before-collection',z.ULT(read,base),[key_domain])
check('source-key-does-not-alias-commit-store',read!=target,[key_domain,inside])
check('key-prefix-invariant-base',z.substitute(invariant,(current,wire)),[key_domain])
check('key-prefix-invariant-step',z.Select(after,read)==z.Select(wire,read),[key_domain,inside,invariant])
# Each parsed destination family discharges the induction step's store premise.
for label,active,relative in m['terms']:
 check(label+'-preserves-key-invariant',z.Select(z.Store(current,base+relative,value),read)==z.Select(wire,read),[key_domain,active,invariant])
# Rewriting the actual source load to the original key gives the same next memory.
actual=z.Store(current,base+v(24)+key_index,z.Select(current,read));frozen=z.Store(current,base+v(24)+key_index,z.Select(wire,read))
check('actual-key-copy-step-equals-frozen-source-step',actual==frozen,[key_domain,invariant])
# A wrongly overlapping source is not stable: first copied byte alters next source byte.
# This negative control drops only source location, retaining the valid write domain.
wrong_read=base+v(25);wrong_target=base+v(25)
check('overlapping-key-source-control',z.Select(z.Store(current,wrong_target,value),wrong_read)==z.Select(wire,wrong_read),[z.Select(current,wrong_read)==z.Select(wire,wrong_read)],z.sat)
(OUT/'key-stability.json').write_text(json.dumps({'passed':True,'claims':rows,'scope':'Array-read induction for the validated serialized state-key span across arbitrary finite sequences of parsed commit-family data stores. The commit source-key load can be replaced by its original-memory value under this invariant. Plan/local scalars remain stable; descriptor/scratch/header object separation and C/VM provenance remain assumptions. The proof driver composes this invariant with the bounded commit sequence.'},indent=2)+'\n')
