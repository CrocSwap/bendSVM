from pathlib import Path
import sys,json,hashlib
sys.path.insert(0,'verification')
from cpi_caller.domain import audit
import z3 as z
assert __debug__
x,y=z.BitVecs('audit_x audit_y',32);g=z.Bool('audit_g');b=z.Bool('audit_b')
rows=[(g,[(x,y),(b,z.BoolVal(True))]),(z.Not(g),[(x,y+1),(b,z.BoolVal(False))])]
equations=lambda r:[z.Implies(guard,a==v) for guard,pairs in r for a,v in pairs]
positive=audit(rows,equations(rows),[],[x,b]);refusals=[]
for name,r,e,allowed in [('missing-output',rows,equations(rows),[x]),('missing-equation',rows,equations(rows)[:-1],[x,b]),('circular-guard',[(x==0,[(x,y)])],None,[x]),('circular-value',[(g,[(x,x+1)])],None,[x]),('duplicate-target',[(g,[(x,y),(x,y+1)])],None,[x]),('overlapping-assignments',[(g,[(x,y)]),(g,[(x,y+1)])],None,[x])]:
 try:audit(r,e if e is not None else equations(r),[],allowed)
 except ValueError as error:refusals.append({'name':name,'reason':str(error)})
 else:raise AssertionError(name)
root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True);files=[Path(__file__),Path('verification/cpi_caller/domain.py')]
(root/'binding-domain-controls.json').write_text(json.dumps({'passed':True,'positive':positive,'refusals':refusals,'inputs':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}},indent=2)+'\n')
print('constructive binding audit: Bool/U32 positives and six refusals passed')
