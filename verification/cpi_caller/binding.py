"""Exact CPI slot/account observations binding to parsed helper."""
import z3 as z
from cpi_composition import validator_relation

def need(ok,label):
 if not ok:raise ValueError(label)
def bv(value,width,label):need(z.is_bv(value) and value.size()==width,'binding width: '+label)
class Validation:
 def __init__(self,files):self.model,self.interpreter,self.actual,self.claims=validator_relation(files)
 def bind(self,slot,count,accounts):
  m=self.model
  expected={(n,) for n in ('active','program','length','count')}
  expected|={(('program_key',),i) for i in range(32)}|{(('data',),i) for i in range(64)}
  expected|={('metas',i,n) for i in range(8) for n in ('index','writable','signer')}
  expected|={(('metas',i,'key'),j) for i in range(8) for j in range(32)}
  need(set(slot)==expected,'exact CPI field inventory')
  for loc,value in slot.items():bv(value,8 if isinstance(loc[0],tuple) else 32,str(loc))
  bv(count,64,'account count');pairs=[(m.count,z.Extract(31,0,count))]
  pairs.extend((v,slot[('count' if n=='meta_count' else n,)]) for n,v in m.fields.items())
  key=lambda prefix:z.Concat(*[slot[(prefix,j)] for j in reversed(range(32))])
  pairs.append((m.program_key,key(('program_key',))))
  for name,field in [('meta_index','index'),('meta_writable','writable'),('meta_signer','signer'),('meta_key','key'),('data',None)]:
   arr=m.arrays[name];mapped=z.K(z.BitVecSort(32),z.BitVecVal(0,arr.range().size()))
   for i in range(64 if name=='data' else 8):
    value=slot[(('data',),i)] if name=='data' else key(('metas',i,'key')) if name=='meta_key' else slot[('metas',i,field)]
    mapped=z.Store(mapped,z.BitVecVal(i,32),value)
   pairs.append((arr,mapped))
  widths={'account_key':256,'executable':32,'writable':32,'signer':32}
  need(set(accounts)==set(widths),'exact account observation inventory')
  for name,width in widths.items():
   values=accounts[name];need(len(values)==12,'twelve account observations required')
   mapped=m.arrays[name]
   for i,value in enumerate(values):
    bv(value,width,name);mapped=z.Store(mapped,z.BitVecVal(i,32),value)
   pairs.append((m.arrays[name],mapped))
  apply=lambda value:z.simplify(z.substitute(value,*pairs))
  pre=z.And(z.UGE(count,z.BitVecVal(4,64)),z.ULE(count,z.BitVecVal(12,64)))
  return apply(self.actual),{'caller-count':pre,**{k:apply(v) for k,v in self.claims.items()}},pairs
