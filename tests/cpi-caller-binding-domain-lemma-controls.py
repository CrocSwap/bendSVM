"""Sensitivity of constructive extension proof to a wrong choice and UNKNOWN."""
from pathlib import Path
import sys,json,hashlib
sys.path.insert(0,'verification')
import z3 as z
assert __debug__
p=Path('verification/cpi_caller/domain.py');source=p.read_text()
x,y=z.BitVecs('lemma_control_x lemma_control_y',32);g=z.Bool('lemma_control_g')
rows=[(g,[(x,y)]),(z.Not(g),[(x,y+1)])];equations=[z.Implies(a,l==r) for a,ps in rows for l,r in ps]
controls=[]
old='generic=z.If(guard,value,generic)';assert source.count(old)==1
namespace={};exec(compile(source.replace(old,'generic=z.If(guard,generic,value)'),str(p)+'-wrong-choice','exec'),namespace)
try:namespace['audit'](rows,equations,[],[x])
except ValueError as e:
 assert 'generic-disjoint-choice' in str(e) and 'sat' in str(e);controls.append({'name':'wrong-generic-choice','reason':str(e)})
else:raise AssertionError('wrong choice accepted')
namespace={};exec(compile(source,str(p),'exec'),namespace)
original=z.Solver
class Unknown:
 def set(self,**kwargs):pass
 def add(self,*args):pass
 def check(self):return z.unknown
try:
 z.Solver=Unknown
 try:namespace['audit'](rows,equations,[],[x])
 except ValueError as e:
  assert 'unknown' in str(e);controls.append({'name':'unknown','reason':str(e)})
 else:raise AssertionError('UNKNOWN accepted')
finally:z.Solver=original
root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
(root/'binding-domain-lemma-controls.json').write_text(json.dumps({'passed':True,'scope':__doc__,'controls':controls,'inputs':{str(x):hashlib.sha256(x.read_bytes()).hexdigest() for x in [p,Path(__file__)]}},indent=2)+'\n')
print('wrong generic choice and UNKNOWN refused')
