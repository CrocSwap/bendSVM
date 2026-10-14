"""First compositional checkpoint after the monolithic div4 query timed out."""
from pathlib import Path
import hashlib,json
base=Path(__file__).resolve().parent;driver=base/'prove-div4.py';ns={'__file__':str(driver),'__name__':'div4_definitions'}
source=driver.read_text();marker="state=execute(text);positive="
if marker not in source:raise RuntimeError('driver shape changed')
exec(compile(source[:source.index(marker)],str(driver),'exec'),ns)
z=ns['z'];q,r,d=ns['q'],ns['r'],ns['d']
state=ns['model'].execute(ns['text'],ns['address'],0x5c50,0x5e08,ns['regs'],{'input':40,'output':40},ns['reader'])
shift=(r<<1)|z.LShR(q,63);reduce=z.Or(z.Extract(63,63,r)==1,z.UGE(shift,d))
r1=z.If(reduce,shift-d,shift);q1=(q<<1)|z.If(reduce,z.BitVecVal(1,64),z.BitVecVal(0,64))
regs=state['registers'];mem=state['memory'];low=lambda v:z.Extract(31,0,v)
claims=[('remainder after first step',z.Concat(low(regs[7]),low(regs[5]))==r1),('quotient low word after first step',low(mem[-24])==low(q1)),('retained quotient inputs and divisor',z.And(regs[4]==z.ZeroExt(32,z.Extract(63,32,q)),regs[9]==z.ZeroExt(32,low(q)),mem[-8]==z.ZeroExt(32,z.Extract(63,32,d)),mem[-16]==z.ZeroExt(32,low(d)))),('unconditional first-step join',state['guard'])]
rows=[ns['solve'](name,claim,z.unsat) for name,claim in claims]
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest();files=[Path(__file__),driver,base/'paths-div4.py',ns['elf'],ns['repo']/'verification/sbf_leaf.py',ns['repo']/'verification/sbf_cfg.py',ns['repo']/'verification/sbf_elf.py']
report={'passed':True,'exploratory':True,'endToEndVerified':False,'inputHashes':{str(p):sha(p) for p in files},'entry':0x5c50,'stop':0x5e08,'instructions':state['coneInstructions'],'claims':rows,'scope':'First div4 reduction step and retained inputs proven for arbitrary U64 q/r/d at an internal cutpoint. Monolithic four-step equivalence timed out; remaining steps, output composition and VM replay are unfinished.'}
(base/'div4-first-step-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'instructions':state['coneInstructions'],'claims':rows}))
