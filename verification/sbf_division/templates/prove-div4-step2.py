"""Universal second-step contract over generalized cutpoint registers."""
from pathlib import Path
import hashlib,json
base=Path(__file__).resolve().parent;driver=base/'prove-div4.py';ns={'__file__':str(driver),'__name__':'div4_definitions'}
source=driver.read_text();exec(compile(source[:source.index('state=execute(text);positive=')],str(driver),'exec'),ns)
z=ns['z'];low=lambda v:z.Extract(31,0,v);ext=lambda v:z.ZeroExt(32,v)
rawlo,rawhi,qlo,oldhi,oldlo=z.BitVecs('remlo remhi qlo oldhi oldlo',64);dh,dl=z.BitVecs('dh dl',32)
regs=[z.BitVec('cut_r'+str(i),64) for i in range(10)]+[('stack',0)]
regs[4]=oldhi;regs[9]=oldlo;regs[5]=rawlo;regs[7]=rawhi;regs[6]=ext(dh)
mem={-8:ext(dh),-16:ext(dl),-24:qlo}
qhi=low((oldhi<<1)|(z.LShR(oldlo,31)&1));q=z.Concat(qhi,low(qlo));r=z.Concat(low(rawhi),low(rawlo));d=z.Concat(dh,dl)
shift=(r<<1)|z.LShR(q,63);take=z.Or(z.Extract(63,63,r)==1,z.UGE(shift,d))
want_r=z.If(take,shift-d,shift);want_q=(q<<1)|z.If(take,z.BitVecVal(1,64),z.BitVecVal(0,64))
state=ns['model'].execute(ns['text'],ns['address'],0x5e08,0x5fb0,regs,{},lambda *_:None,mem)
out=state['registers'];memory=state['memory'];next_hi=low(((out[4]|out[9])<<1)|(z.LShR(memory[-24],31)&1))
claims=[('second-step remainder',z.Concat(low(out[8]),low(out[5]))==want_r),('second-step quotient',z.Concat(next_hi,low(memory[-32]))==want_q),('retained divisor and previous quotient',z.And(out[6]==ext(dh),memory[-8]==ext(dh),memory[-16]==ext(dl),memory[-24]==qlo)),('second-step unconditional join',state['guard'])]
rows=[ns['solve'](name,claim,z.unsat) for name,claim in claims]
# Bind real first-step exit to this generalized entry without assuming its spec.
first=ns['model'].execute(ns['text'],ns['address'],0x5c50,0x5e08,ns['regs'],{'input':40,'output':40},ns['reader'])
f=first['registers'];fm=first['memory']
bridge=z.And(f[6]==z.ZeroExt(32,z.Extract(63,32,ns['d'])),fm[-8]==f[6],fm[-16]==z.ZeroExt(32,low(ns['d'])))
rows.append(ns['solve']('actual first-step exit satisfies second-step divisor bindings',bridge,z.unsat))
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest();files=[Path(__file__),driver,base/'paths-div4.py',ns['elf'],ns['repo']/'verification/sbf_leaf.py',ns['repo']/'verification/sbf_cfg.py',ns['repo']/'verification/sbf_elf.py']
report={'passed':True,'exploratory':True,'endToEndVerified':False,'inputHashes':{str(p):sha(p) for p in files},'entry':0x5e08,'stop':0x5fb0,'instructions':state['coneInstructions'],'claims':rows,'scope':'Second div4 step under explicit generalized cutpoint interpretation; actual prior exit discharges divisor bindings. Quotient/remainder interpretation is checked by separate first-step theorem. Final four-step induction/composition receipt, remaining two steps and VM replay remain unfinished.'}
(base/'div4-step2-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'instructions':state['coneInstructions'],'claims':rows}))
