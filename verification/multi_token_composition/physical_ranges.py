"""Derive physical span premises from actual instantiated serialized decoder.

Caller success/count/parse facts must be separately proved on the supplied world.
Each subsequent range cut is inserted only after its concrete query passes.
"""
import z3 as z

def analyse(w,ld,positions,inst,run):
 v=lambda n:z.BitVecVal(n,64);limit=10*1024*1024;stride=88+limit+10240+7+8
 active=lambda i:z.ULT(v(i),w.COUNT)
 starts=[positions[i]+inst(ld['actual']['data'],positions[i]) for i in range(12)]
 # These are exactly the loader equations used by the serialized child.
 initial=[positions[0]==v(8),z.ULE(w.COUNT,v(12))]
 parsed=[z.Implies(active(i),w.PARSE_OK[i]) for i in range(12)]
 equations=[];domains=[]
 for i in range(12):
  at=positions[i]
  equations.extend([z.Implies(active(i),w.PARSE_OK[i]==z.Not(inst(ld['reject'],at))),z.Implies(active(i),w.SIZE[i]==inst(ld['actual']['size'],at)),z.Implies(active(i),positions[i+1]==at+inst(ld['end_offset'],at))])
  domains.extend(z.Implies(active(i),inst(p,at)) for p in ld['premises'])
 cuts=[];rows=[]
 def check(name,claim,premises):
  solver=z.Solver();solver.set(timeout=30000);solver.add(*premises,z.Not(claim));status=solver.check()
  (run/(name+'.smt2')).write_text(solver.to_smt2());assert status==z.unsat,(name,str(status),solver.reason_unknown())
  rows.append({'name':name,'result':str(status)});print(name,status,flush=True);cuts.append(claim)
 for i in range(12):
  at=positions[i]
  bound=z.And(z.UGE(at,v(8)),z.ULE(at,v(8+i*stride)),(at&v(7))==0)
  check('caller-cursor-'+str(i),z.Implies(active(i),bound),[*initial,*cuts])
  extent=z.And(z.UGT(starts[i],at),z.ULE(starts[i],v(1<<32)),z.ULE(w.SIZE[i],v(limit)),z.UGE(starts[i]+w.SIZE[i],starts[i]),z.ULE(starts[i]+w.SIZE[i],positions[i+1]),z.UGT(positions[i+1],at),z.ULE(positions[i+1],v(8+(i+1)*stride)),(positions[i+1]&v(7))==0)
  # Only this decoder's equations/domain, plus previously proved cursor bounds.
  check('caller-decoded-extent-'+str(i),z.Implies(active(i),extent),[*initial,*cuts,parsed[i],*equations[3*i:3*i+3],*domains[len(ld['premises'])*i:len(ld['premises'])*(i+1)]])
 for i in range(12):
  for j in range(i+1,12):
   check('caller-separated-'+str(i)+'-'+str(j),z.Implies(z.And(active(i),active(j)),z.ULE(starts[i]+w.SIZE[i],starts[j])),[*initial,*cuts])
 return {'claims':rows,'scope':'Concrete serialized decoder equations and caller prefix success cuts imply bounded ordered disjoint data spans. Runtime valid-allocation premises remain trusted.'},cuts
