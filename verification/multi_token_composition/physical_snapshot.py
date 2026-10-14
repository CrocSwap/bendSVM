"""Reusable fresh finite snapshot embedding theorem and symbolic contract."""
import z3 as z

def prove(run,cache=None):
 v=lambda x:z.BitVecVal(x,64);v32=lambda x:z.BitVecVal(x,32)
 starts=[z.BitVec('start_'+str(i),64) for i in range(12)]
 lengths=[z.BitVec('length_'+str(i),64) for i in range(12)]
 count=z.BitVec('count',64);offset=z.BitVec('view_offset',32);address=z.BitVec('address',64)
 active=lambda i:z.ULT(v(i),count)
 snapshots=z.Array('snapshots',z.BitVecSort(32),z.ArraySort(z.BitVecSort(32),z.BitVecSort(8)))
 before=z.Array('before',z.BitVecSort(64),z.BitVecSort(8))
 domain=[z.ULE(count,v(12))]
 for i in range(12):
  domain.append(z.Implies(active(i),z.And(z.ULE(starts[i],v(1<<32)),z.ULE(lengths[i],v(10*1024*1024)))))
 separation=[z.Implies(z.And(active(i),active(j)),z.ULE(starts[i]+lengths[i],starts[j])) for i in range(12) for j in range(i+1,12)]
 def patch(memory,i):
  return z.Lambda(address,z.If(z.And(active(i),z.UGE(address,starts[i]),z.ULT(address,starts[i]+lengths[i])),z.Select(z.Select(snapshots,v32(i)),z.Extract(31,0,address-starts[i])),z.Select(memory,address)))
 rows=[]
 def check(name,claim,premises,wanted=z.unsat):
  solver=z.Solver();solver.set(timeout=30000);solver.add(*premises,z.Not(claim));status=((cache.check(name,solver) or z.unsat) if cache is not None and wanted==z.unsat else solver.check())
  (run/(name+'.smt2')).write_text(solver.to_smt2())
  assert status==wanted,(name,str(status),solver.reason_unknown())
  row={'name':name,'result':str(status)}
  if status==z.sat:row['countermodel']=str(solver.model())
  rows.append(row);print(name,status,flush=True)
 memory=before
 for k in range(12):
  memory=patch(memory,k)
  for i in range(k+1):
   read=starts[i]+z.ZeroExt(32,offset)
   claim=z.Select(memory,read)==z.Select(z.Select(snapshots,v32(i)),offset)
   check('stage-'+str(k)+'-account-'+str(i),claim,[*domain,*separation,active(i),z.ULT(z.ZeroExt(32,offset),lengths[i])])
 # Includes metadata and bytes outside all active account-data ranges.
 outside=[z.Implies(active(i),z.Or(z.ULT(address,starts[i]),z.UGE(address,starts[i]+lengths[i]))) for i in range(12)]
 check('outside-all-active-data-preserved',z.Select(memory,address)==z.Select(before,address),[*domain,*outside])
 read=starts[0]+z.ZeroExt(32,offset);target=z.Select(z.Select(snapshots,v32(0)),offset)
 missing=before
 for i in range(1,12):missing=patch(missing,i)
 check('omitted-first-snapshot',z.Select(missing,read)==target,[*domain,*separation,count==v(2),z.ULT(z.ZeroExt(32,offset),lengths[0])],z.sat)
 check('omitted-separation',z.Select(memory,read)==target,[*domain,count==v(2),z.ULT(z.ZeroExt(32,offset),lengths[0])],z.sat)
 solver=z.Solver();solver.add(*domain,*separation,count==v(12))
 for i in range(12):solver.add(starts[i]==v(88+i*10400),lengths[i]==v(64))
 assert solver.check()==z.sat
 return {'claims':rows,'nonemptyTwelveAccountWitness':'sat'}, {'starts':starts,'lengths':lengths,'count':count,'domain':domain+separation,'snapshots':snapshots,'before':before,'memory':memory,'offset':offset}
