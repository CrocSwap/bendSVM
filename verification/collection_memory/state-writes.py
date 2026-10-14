if not __debug__:raise RuntimeError('memory proof assertions required')
from pathlib import Path
import os
OUT=Path(os.environ.get("MEMORY_RUN_DIR","build/collection-memory"))
import runpy,json
import z3 as z
q=(globals().get('qualified_caller') or runpy.run_path('verification/collection_memory/connect-caller.py',run_name='__main__'));r=q['r'];m=q['m'];paths=q['paths'];v=q['v'];commit=q['commit'];constraints=q['constraints'];run=q['run'];core=m['core']
state_base=q['actual_base']+r['c']['address'](0,'data');collection_base=q['actual_base']+r['c']['address'](2,'data');size=q['field'](2,'size')
previous=z.Array('memory_after_collection_commit',z.BitVecSort(64),z.BitVecSort(8));payload=[z.Extract(7,0,paths.input('encoded_state_byte_'+str(i),8)) for i in range(5)];header=[z.BitVecVal(x,8) for x in core['interface']['header']];expected=header+payload
# Exact 20+5 destinations were matched against generated memcpy calls upstream.
def execute(shift=0):
 after=previous
 for i,b in enumerate(header):after=z.Store(after,state_base+v(i),b)
 for i,b in enumerate(payload):after=z.Store(after,state_base+v(20+i+shift),b)
 return after
final=execute();rows=[]
def check(name,condition,extra=(),wanted=z.unsat):
 s=z.Solver();s.set(timeout=60000);s.add(*constraints,commit,*extra,z.Not(condition));result=s.check();print(name,result,flush=True);assert result==wanted,(name,result,s.reason_unknown());rows.append({'name':name,'result':str(result)})
check('state-copy-complete-canonical-bytes',z.And(*[z.Select(final,state_base+v(i))==b for i,b in enumerate(expected)]))
encoded_calls=z.Concat(*[z.Select(final,state_base+v(i)) for i in (24,23,22,21)])
check('stored-state-calls-follow-source',encoded_calls==core['old_calls']+1)
check('stored-state-constructor-tag',z.Select(final,state_base+v(20))==0)
read=z.BitVec('state_copy_frame_read',64);outside=z.Or(z.ULT(read,state_base),z.UGE(read,state_base+v(25)));disjoint=z.And(*[read!=state_base+v(i) for i in range(25)])
check('outside-state-copy-addresses-disjoint',disjoint,[outside])
check('state-copy-global-frame',z.Select(final,read)==z.Select(previous,read),[outside,disjoint])
inside_collection=z.And(z.UGE(read,collection_base),z.ULT(read,collection_base+size))
check('collection-is-outside-state-copy',outside,[inside_collection])
check('state-copy-preserves-committed-collection',z.Select(final,read)==z.Select(previous,read),[inside_collection,outside,disjoint])
# Source U32 addition is modulo 2^32, including a reachable wraparound case.
check('counter-wraparound-reachable',z.BoolVal(False),[core['old_calls']==z.BitVecVal(0xffffffff,32)],z.sat)
wrong=execute(1);check('shifted-state-payload-control',z.And(*[z.Select(wrong,state_base+v(i))==b for i,b in enumerate(expected)]),wanted=z.sat)
q['fresh_report'].validate(q['receipt']['beforeArtifact'],q['receipt']['inputArtifact'])
(run/'state-writes.json').write_text(json.dumps({'passed':True,'claims':rows,'entryReceipt':q['receipt'],'scope':'Exact generated20+5state-copy destination sequence, connected encoded state outputs and global frame over an arbitrary post-collection array. Preserves committed collection bytes; collection post-state/key lemmas are separate composition evidence. Local scratch separation, valid C objects, return syscall and SBF remain assumptions.'},indent=2)+'\n');print(run,flush=True)
