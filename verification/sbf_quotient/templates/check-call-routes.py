from pathlib import Path
import sys,json,hashlib
import z3 as z
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
import sbf_leaf as m
from sbf_elf import text_section
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes())
q,h,d,saved=z.BitVecs('q h d saved',64)
lo=lambda x:z.Extract(31,0,x);hi=lambda x:z.Extract(63,32,x);ext=lambda x:z.ZeroExt(32,x)
raw=lambda name,v:z.Concat(z.BitVec(name,32),v)
r=[z.BitVec('route_r'+str(i),64) for i in range(10)]+[('stack',0)]
r[0]=raw('upper_hlo',lo(h));r[1]=ext(hi(d));r[2]=raw('upper_dhi',hi(d));r[3]=saved;r[4]=raw('upper_dlo',lo(d));r[8]=raw('upper_hhi',hi(h))
mem={-0x108:ext(lo(d)),-0x140:ext(hi(d))<<32,-0x150:raw('upper_qlo',lo(q)),-0xa8:raw('upper_qhi',hi(q)),-0x170:ext(hi(q))<<32,-0x160:z.BitVec('deferred_flag',64)}
rows=[]
def prove(name,claim,want=z.unsat):
 s=z.Solver();s.set(timeout=10000);s.add(z.Not(claim));result=s.check();assert result==want,(name,result,s.reason_unknown());row={'name':name,'result':str(result)}
 if result==z.sat:row['witness']=str(s.model())
 rows.append(row)
branches=[('direct',0x24a8,d==1),('native',0x2610,z.And(d!=1,h==0)),('restoring',0x2500,z.And(d!=1,h!=0,hi(d)!=0)),('small',0x2680,z.And(d!=1,h!=0,hi(d)==0))]
for name,stop,want in branches:
 st=m.execute(text,address,0x2490,stop,r,{},lambda *_:None,mem)
 prove(name+' exact guard',st['guard']==want)
 if name=='native':
  prove('complete native slice input binding',z.Implies(st['guard'],z.And(st['registers'][5]==ext(lo(d)),st['memory'][-0x140]==mem[-0x140],st['registers'][3]==saved,*[st['memory'][k]==mem[k] for k in [-0x150,-0x170]])))
 if name=='small':
  prove('complete small slice input binding',z.Implies(st['guard'],z.And(st['registers'][5]==ext(lo(d)),st['memory'][-0xe0]==saved,*[st['memory'][k]==mem[k] for k in [-0x150,-0x160]])))
 s=z.Solver();s.add(d!=0,z.ULT(h,d),st['guard']);assert s.check()==z.sat;rows.append({'name':name+' valid nonvacuity','result':'sat','witness':str(s.model())})
prove('exhaustive exclusive router partition',z.And(z.Or(*[b[2] for b in branches]),*[z.Not(z.And(branches[i][2],branches[j][2])) for i in range(len(branches)) for j in range(i)]))
direct=m.execute(text,address,0x24a8,0x2748,r,{},lambda *_:None,mem)
prove('direct emitted result and context',z.And(direct['guard'],direct['memory'][-0xa8]==q,direct['registers'][3]==saved))
prove('valid direct input has zero high dividend',z.Implies(z.And(d==1,z.ULT(h,d)),h==0))
bad=bytearray(text);assert bad[0x24e8-address]==0x15;bad[0x24e8-address]=0x55
st=m.execute(bytes(bad),address,0x2490,0x2610,r,{},lambda *_:None,mem)
prove('inverted high word route detected',st['guard']==z.And(d!=1,h==0),z.sat)
files=[Path(__file__),elf,repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py']
(base/'call-routes-report.json').write_text(json.dumps({'passed':True,'exploratory':True,'endToEndVerified':False,'claims':rows,'inputHashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files},'scope':'Current emitted route partition and native-input binding under declared product/divisor register interpretation. Connection from actual product tail remains pending.'},indent=2)+'\n')

print(json.dumps({'passed':True,'claims':len(rows)}))
