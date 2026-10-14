"""Staged reusable physical-memory proof primitives; fresh loader namespace required."""
import z3 as z

def ranges(ld,run,cache=None):
 ns=ld
 v=lambda n:z.BitVecVal(n,64);rows=[];controls=[]
 def check(name,claim,premises,wanted=z.unsat):
  s=z.Solver();s.set(timeout=30000);s.add(*premises,z.Not(claim));status=((cache.check(name,s) or z.unsat) if cache is not None and wanted==z.unsat else s.check());assert status==wanted,(name,str(status),s.reason_unknown());r={'name':name,'result':str(status)}
  if status==z.sat:r['witness']=str(s.model())
  print(name,status,flush=True);return r
 # Local extent uses the actual parsed decoder end, not an assumed stride.
 limit=10*1024*1024;stride=88+limit+10240+7+8
 cursor=z.BitVec('cursor',64);length=ns['length']
 parsed=z.substitute(ns['end_offset'],(ns['base'],v(0x100000000)+cursor))
 domain=[*ns['premises'],ns['base']==v(0x100000000)+cursor,z.UGE(cursor,v(8)),z.ULE(cursor,v(8+12*stride)),cursor&v(7)==0,z.Not(ns['reject'])]
 data_start=cursor+ns['actual']['data'];data_end=data_start+length;next_record=cursor+parsed
 local=z.And(z.UGT(data_start,cursor),z.UGE(data_end,data_start),z.ULE(data_end,next_record),z.UGT(next_record,cursor),z.ULE(next_record,v(8+13*stride)))
 rows.append(check('parsed-record-data-contained-before-next',local,domain))
 for i in range(12):
  step_domain=[*domain,z.ULE(cursor,v(8+i*stride))]
  step_claim=z.And(local,z.ULE(next_record,v(8+(i+1)*stride)),(next_record&v(7))==0)
  rows.append(check('parsed-extent-induction-'+str(i),step_claim,step_domain))
 # Fresh proved local extent gives the following cut for each successfully decoded
 # record. Cursor ordering is established by each local theorem, then composed.
 positions=[z.BitVec('record_'+str(i),64) for i in range(13)]
 starts=[positions[i]+v(88) for i in range(12)]
 ends=[z.BitVec('data_end_'+str(i),64) for i in range(12)]
 count=z.BitVec('parsed_count',64)
 active=lambda i:z.ULT(v(i),count)
 chain=[positions[0]==v(8),z.ULE(count,v(12))]
 for i in range(12):
  # This input bound is derived from the preceding conditional step, not an
  # assumption about inactive records. Each local step was freshly proved above.
  bound=z.ULE(positions[i],v(8+i*stride))
  rows.append(check('active-cursor-input-bound-'+str(i),z.Implies(active(i),bound),chain))
  local_cut=z.And(z.UGT(starts[i],positions[i]),z.UGE(ends[i],starts[i]),z.ULE(ends[i],positions[i+1]),z.UGT(positions[i+1],positions[i]),z.ULE(positions[i+1],v(8+(i+1)*stride)),(positions[i+1]&v(7))==0)
  chain.append(z.Implies(z.And(active(i),bound),local_cut))
 for i in range(12):
  for j in range(i+1,12):
   rows.append(check('active-ordered-disjoint-data-'+str(i)+'-'+str(j),z.Implies(z.And(active(i),active(j)),z.ULE(ends[i],positions[j])),chain))
 # Commit projection uses only the modeled managed prefix of each account.
 widths=[z.BitVec('managed_width_'+str(i),64) for i in range(12)]
 for i in range(12):
  valid=[*chain,active(i),z.ULE(widths[i],ends[i]-starts[i])]
  claim=z.And(z.ULE(starts[i],v(1<<32)),z.UGE(starts[i]+widths[i],starts[i]),z.ULE(starts[i]+widths[i],ends[i]))
  rows.append(check('active-managed-prefix-extent-'+str(i),claim,valid))
 for i in range(12):
  for j in range(i+1,12):
   valid=[*chain,active(i),active(j),z.ULE(widths[i],ends[i]-starts[i]),z.ULE(widths[j],ends[j]-starts[j])]
   rows.append(check('active-managed-prefix-disjoint-'+str(i)+'-'+str(j),z.ULE(starts[i]+widths[i],starts[j]),valid))
 # A write to one data span leaves all bytes of another record unchanged.
 write,read=z.BitVecs('write read',64);before=z.Array('memory_before',z.BitVecSort(64),z.BitVecSort(8));value=z.BitVec('write_value',8)
 a,b,c,d=z.BitVecs('data_a_start data_a_end record_b_start record_b_end',64)
 separate=[z.ULE(a,b),z.ULE(b,c),z.ULE(c,d),z.UGE(write,a),z.ULT(write,b),z.UGE(read,c),z.ULT(read,d)]
 rows.append(check('forward-store-preserves-other-record',z.Select(z.Store(before,write,value),read)==z.Select(before,read),separate))
 rows.append(check('reverse-store-preserves-other-record',z.Select(z.Store(before,read,value),write)==z.Select(before,write),separate))
 # Missing size in next cursor can put a subsequent record inside current data.
 wrong_next=cursor+v(88+10240+8)
 controls.append(check('omitted-data-length-overlaps-next-record',z.ULE(data_end,wrong_next),domain,z.sat))
 # Missing separation permits a real counterexample to write noninterference.
 controls.append(check('omitted-span-separation',z.Select(z.Store(before,write,value),read)==z.Select(before,read),[p for p in separate if not z.eq(p,z.ULE(b,c))],z.sat))
 s=z.Solver();s.add(*chain,count==5)
 for i in range(13):s.add(positions[i]==v(8+i*10400))
 for i in range(12):s.add(ends[i]==starts[i]+v(64))
 assert s.check()==z.sat
 return {'claims':rows,'controls':controls,'witness':'sat'}

def translation(ld,run,cache=None):
 v=lambda n:z.BitVecVal(n,64);b=ld['base'];reference=v(0x100000000)
 aligned=(b&v(7))==0;rows=[]
 def check(name,claim,premises=(),wanted=z.unsat):
  solver=z.Solver();solver.set(timeout=30000);solver.add(*premises,z.Not(claim));answer=((cache.check(name,solver) or z.unsat) if cache is not None and wanted==z.unsat else solver.check());assert answer==wanted,(name,str(answer),solver.reason_unknown())
  row={'name':name,'result':str(answer)}
  if answer==z.sat:row['witness']=str(solver.model())
  (run/(name+'.smt2')).write_text(solver.to_smt2());rows.append(row);print(name,answer,flush=True)
 for name,term in [*ld['actual'].items(),('reject',ld['reject']),('rent-offset',ld['rent_offset']),('next-offset',ld['end_offset'])]:
  check('base-invariant-'+name,term==z.substitute(term,(b,reference)),[aligned])
 # A fresh equal-offset theorem also applies under the byte reader.
 rent_equal=ld['rent_offset']==z.substitute(ld['rent_offset'],(b,reference))
 # Prove read congruence on arbitrary offsets; instantiate only after the
 # actual rent-offset equality was freshly proved above. This avoids asking
 # the bit-vector solver to rediscover congruence amid address arithmetic.
 left_offset,right_offset=z.BitVecs('translation_read_left translation_read_right',64)
 congruence=ld['le'](left_offset)==ld['le'](right_offset)
 check('base-invariant-rent-read',congruence,[left_offset==right_offset])
 replacements=[(left_offset,ld['rent_offset']),(right_offset,z.substitute(ld['rent_offset'],(b,reference)))]
 assert z.eq(z.substitute(left_offset==right_offset,*replacements),rent_equal)
 actual_read=ld['le'](ld['rent_offset'])==ld['le'](z.substitute(ld['rent_offset'],(b,reference)))
 assert z.eq(z.substitute(congruence,*replacements),actual_read)
 check('missing-alignment',rent_equal,(),z.sat)
 # Preserve valid native bounds for every possible active record start.
 limit=10*1024*1024;stride=88+limit+10240+7+8;extent=8+12*stride+2048
 allocation,cursor=z.BitVecs('allocation_base record_cursor',64)
 domain=[allocation!=0,(allocation&v(7))==0,z.ULE(allocation,v((1<<64)-1-extent)),z.UGE(cursor,v(8)),z.ULE(cursor,v(8+11*stride)),(cursor&v(7))==0]
 record_base=allocation+cursor
 check('active-record-base-domain',z.And(record_base!=0,(record_base&v(7))==0,z.UGE(record_base,allocation),z.ULE(record_base,v((1<<64)-1-(limit+10400)))),domain)
 left,right=z.BitVecs('left right',64)
 check('translated-order',z.ULE(allocation+left,allocation+right),[allocation!=0,z.ULE(allocation,v((1<<64)-1-extent)),z.ULE(left,right),z.ULE(right,v(extent))])
 check('missing-nonwrapping-allocation',z.ULE(allocation+left,allocation+right),[z.ULE(left,right),z.ULE(right,v(extent))],z.sat)
 # Address translation is a bijection for the complete BV64 array. Allocation
 # bounds above additionally justify interpreting its active region as pointers.
 relative=z.Array('relative_memory',z.BitVecSort(64),z.BitVecSort(8));address,read,write=z.BitVecs('address read write',64);value=z.BitVec('value',8)
 translate=lambda memory:z.Lambda(address,z.Select(memory,address-allocation))
 check('translated-byte-view',z.Select(translate(relative),allocation+read)==z.Select(relative,read))
 check('translated-store',z.Select(z.Store(translate(relative),allocation+write,value),allocation+read)==z.Select(translate(z.Store(relative,write,value)),allocation+read))
 check('shifted-translated-store',z.Select(z.Store(translate(relative),allocation+write+v(1),value),allocation+read)==z.Select(translate(z.Store(relative,write,value)),allocation+read),(),z.sat)
 solver=z.Solver();solver.add(*domain,allocation>v(1<<40));assert solver.check()==z.sat
 return {'claims':rows,'highBaseWitness':'sat'}

def patch(ld,run,cache=None):
 v=lambda n:z.BitVecVal(n,64)
 start,length,other,other_length=z.BitVecs('start length other other_length',64)
 offset=z.BitVec('offset',32);address=z.BitVec('address',64)
 before=z.Array('before',z.BitVecSort(64),z.BitVecSort(8));snapshot=z.Array('account_snapshot',z.BitVecSort(32),z.BitVecSort(8))
 def patch(start,length,shift=0):
  return z.Lambda(address,z.If(z.And(z.UGE(address,start),z.ULT(address,start+length)),z.Select(snapshot,z.Extract(31,0,address-start)+z.BitVecVal(shift,32)),z.Select(before,address)))
 updated=patch(start,length);read=start+z.ZeroExt(32,offset)
 domain=[z.ULE(start,v(1<<32)),z.ULE(length,v(10*1024*1024)),z.ULT(z.ZeroExt(32,offset),length)]
 rows=[]
 def check(name,premises,claim,wanted):
  solver=z.Solver();solver.set(timeout=30000);solver.add(*premises,z.Not(claim));answer=((cache.check(name,solver) or z.unsat) if cache is not None and wanted==z.unsat else solver.check());assert answer==wanted,(name,str(answer),solver.reason_unknown())
  (run/(name+'.smt2')).write_text(solver.to_smt2());row={'name':name,'result':str(answer)}
  if answer==z.sat:row['witness']=str(solver.model())
  rows.append(row);print(name,answer,flush=True)
 check('own-bounded-view',domain,z.Select(updated,read)==z.Select(snapshot,offset),z.unsat)
 separation=z.Or(z.ULE(start+length,other),z.ULE(other+other_length,start))
 other_domain=[z.ULE(start,v(1<<32)),z.ULE(length,v(10*1024*1024)),z.ULE(other,v(1<<32)),z.ULE(other_length,v(10*1024*1024)),z.ULT(z.ZeroExt(32,offset),other_length)]
 other_read=other+z.ZeroExt(32,offset)
 check('separate-account-preserved',other_domain+[separation],z.Select(updated,other_read)==z.Select(before,other_read),z.unsat)
 check('outside-data-preserved',[z.Not(z.And(z.UGE(address,start),z.ULT(address,start+length)))],z.Select(updated,address)==z.Select(before,address),z.unsat)
 check('missing-patch',domain,z.Select(before,read)==z.Select(snapshot,offset),z.sat)
 check('shifted-snapshot-offset',domain,z.Select(patch(start,length,1),read)==z.Select(snapshot,offset),z.sat)
 check('missing-separation',other_domain,z.Select(updated,other_read)==z.Select(before,other_read),z.sat)
 solver=z.Solver();solver.add(*domain,length==165,offset==164);assert solver.check()==z.sat
 return {'claims':rows,'nonemptyLastByteWitness':'sat'}

def store(ld,run,cache=None):
 v=lambda n:z.BitVecVal(n,64)
 a,b,alen,blen,write,read=z.BitVecs('a b alen blen write_offset read_offset',64)
 mem=z.Array('memory',z.BitVecSort(64),z.BitVecSort(8));value=z.BitVec('value',8)
 rows=[]
 def check(name,premises,claim,wanted):
  s=z.Solver();s.set(timeout=30000);s.add(*premises,z.Not(claim));status=((cache.check(name,s) or z.unsat) if cache is not None and wanted==z.unsat else s.check());assert status==wanted,(name,str(status),s.reason_unknown())
  row={'name':name,'result':str(status)}
  if status==z.sat:row['witness']=str(s.model())
  (run/(name+'.smt2')).write_text(s.to_smt2());rows.append(row);print(name,status,flush=True)
 # Translation by the same address is injective in BV64, even before applying
 # the separate valid-allocation contract. Every original managed read survives
 # except the exact overwritten byte.
 after=z.Store(mem,a+write,value)
 check('same-account-store-projection',[],z.Select(after,a+read)==z.If(read==write,value,z.Select(mem,a+read)),z.unsat)
 # An arbitrary byte in a different, disjoint nonwrapping span is unaffected.
 domain=[z.ULE(a,v(1<<32)),z.ULE(b,v(1<<32)),z.ULE(alen,v(10*1024*1024)),z.ULE(blen,v(10*1024*1024)),z.ULT(write,alen),z.ULT(read,blen)]
 separation=z.Or(z.ULE(a+alen,b),z.ULE(b+blen,a))
 check('other-account-store-projection',domain+[separation],z.Select(after,b+read)==z.Select(mem,b+read),z.unsat)
 check('missing-separation',domain,z.Select(after,b+read)==z.Select(mem,b+read),z.sat)
 check('shifted-store-address',[],z.Select(z.Store(mem,a+write+v(1),value),a+read)==z.If(read==write,value,z.Select(mem,a+read)),z.sat)
 # Even a write at the final valid byte preserves the proof domain.
 check('last-byte-boundary',domain+[write==alen-v(1)],z.And(z.UGE(a+write,a),z.ULT(a+write,a+alen)),z.unsat)
 s=z.Solver();s.add(*domain,separation,alen>0,blen>0);assert s.check()==z.sat
 return {'claims':rows,'nonemptyDomain':'sat'}

def prove(ld,root,caches=None):
 result={}
 for name,function in [('ranges',ranges),('translation',translation),('patch',patch),('store',store)]:
  folder=root/name;folder.mkdir()
  result[name]=function(ld,folder,None if caches is None else caches[name])
 return result
