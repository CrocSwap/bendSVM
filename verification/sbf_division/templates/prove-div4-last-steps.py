"""Third/fourth step contracts with explicit typed frame-pointer slot."""
from pathlib import Path
import hashlib,importlib.util,json
base=Path(__file__).resolve().parent;driver=base/'prove-div4.py';ns={'__file__':str(driver),'__name__':'div4_definitions'}
s=driver.read_text();exec(compile(s[:s.index('state=execute(text);positive=')],str(driver),'exec'),ns)
z=ns['z'];low=lambda v:z.Extract(31,0,v);ext=lambda v:z.ZeroExt(32,v)
source=(base/'paths-div4.py').read_text();path=base/'paths-div4-frames.py';path.write_text(source)
spec=importlib.util.spec_from_file_location('div4_frames',path);model=importlib.util.module_from_spec(spec);spec.loader.exec_module(model)
rawlo,rawhi,qlo,previous_lo,partial_hi=z.BitVecs('rawlo rawhi qlo previous_lo partial_hi',64)
dh,dl=z.BitVecs('dh dl',32);carry=z.BitVec('carry',1);carry64=z.ZeroExt(63,carry);d=z.Concat(dh,dl)
rows=[];states={}
for step,start,stop in [(3,0x5fb0,0x6158),(4,0x6158,0x6390)]:
 regs=[z.BitVec('cut'+str(step)+'_r'+str(i),64) for i in range(10)]+[('stack',0)]
 regs[4]=partial_hi;regs[5]=rawlo
 mem={-8:ext(dh),-16:ext(dl),-40:('output',0)}
 if step==3:
  regs[8]=rawhi;regs[9]=carry64;regs[6]=ext(dh);regs[2]=ext(dl)
  mem.update({-24:previous_lo,-32:qlo})
 else:
  regs[7]=rawhi;regs[2]=carry64;regs[3]=ext(dh);regs[9]=qlo
  mem.update({-32:previous_lo})
 qhi=low(((partial_hi|carry64)<<1)|(z.LShR(previous_lo,31)&1));q=z.Concat(qhi,low(qlo));r=z.Concat(low(rawhi),low(rawlo))
 shifted=(r<<1)|z.LShR(q,63);take=z.Or(z.Extract(63,63,r)==1,z.UGE(shifted,d))
 wr=z.If(take,shifted-d,shifted);wq=(q<<1)|z.If(take,z.BitVecVal(1,64),z.BitVecVal(0,64))
 state=model.execute(ns['text'],ns['address'],start,stop,regs,{'output':40},lambda *_:None,mem)
 out=state['registers'];memory=state['memory'];states[str(step)]={'instructions':state['coneInstructions'],'poisonMerges':state['poisonMerges']}
 if step==3:
  qout=z.Concat(low(((out[4]|out[2])<<1)|(z.LShR(memory[-32],31)&1)),low(out[9]))
  rout=z.Concat(low(out[7]),low(out[5]))
  frame=z.And(out[3]==ext(dh),memory[-8]==ext(dh),memory[-16]==ext(dl),memory[-32]==qlo,z.ULE(out[2],1))
  if memory[-40]!=('output',0):raise RuntimeError('lost output pointer')
  claims=[('quotient',qout==wq),('remainder',rout==wr),('next-entry divisor/carry/frame',frame)]
 else:
  output={k[1]:v for k,v in memory.items() if isinstance(k,tuple)}
  if set(output)!=set(range(0,40,4)):raise RuntimeError('output footprint')
  claims=[('quotient',z.Concat(output[12],output[8])==wq),('remainder',z.Concat(output[24],output[20])==wr),('divisor and all tags',z.And(z.Concat(output[36],output[32])==d,*[output[k]==0 for k in [0,4,16,28]]))]
 for name,claim in claims+[('unconditional join',state['guard'])]:rows.append(ns['solve']('step'+str(step)+' '+name,claim,z.unsat))
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest();files=[Path(__file__),driver,path,base/'paths-div4.py',ns['elf'],ns['repo']/'verification/sbf_leaf.py',ns['repo']/'verification/sbf_cfg.py',ns['repo']/'verification/sbf_elf.py']
report={'passed':True,'exploratory':True,'endToEndVerified':False,'inputHashes':{str(p):sha(p) for p in files},'steps':states,'claims':rows,'scope':'Universal third/fourth emitted div4 step contracts and final 40-byte output. Explicit generalized entry maps and pointer frame required; full inter-step substitution/induction receipt and VM replay still pending.'}
(base/'div4-last-steps-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'steps':states,'claims':rows}))
