"""Conditional carry-routing theorem over the current SBF instruction slice."""
from pathlib import Path
import hashlib, importlib.util, json, struct
import z3 as z
if not __debug__:raise RuntimeError('assertions required')
base=Path(__file__).resolve().parent
prior=base.parent/'sbf-slice-probe'
spec=importlib.util.spec_from_file_location('slice',prior/'check.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def execute(code,regs,mem):
    c.need(len(code)%8==0,'instruction alignment')
    regs=list(regs);mem=dict(mem);writes=set();pc=0;branches=0
    while pc<len(code):
        op,ds,off,imm=struct.unpack_from('<BBhi',code,pc)
        if op in (0x5d,0x1d):
            dst=ds&15;src=ds>>4
            c.need(dst<10 and src<10 and off in (1,2) and imm==0,'conditional skip shape')
            c.need(pc+8*(off+1)<=len(code),'conditional fallthrough bounds')
            nop,nds,noff,nimm=struct.unpack_from('<BBhi',code,pc+8)
            c.need(nop==0xb7 and nds<10 and noff==0,'conditional assignment shape')
            taken=regs[dst]!=regs[src] if op==0x5d else regs[dst]==regs[src]
            fall_regs,fall_mem,fall_writes,_=c.execute(code[pc+8:pc+8*(off+1)],regs,mem)
            if off==2:
                sop,sds,soff,simm=struct.unpack_from('<BBhi',code,pc+16)
                c.need(sop==0x7b and sds==((nds<<4)|10) and simm==0 and soff in mem,'conditional store shape')
            regs=[z.If(taken,old,new) for old,new in zip(regs,fall_regs)]
            mem={k:z.If(taken,mem[k],v) if k in fall_writes else v for k,v in fall_mem.items()}
            writes|=fall_writes;branches+=1;pc+=8*(off+1)
        else:
            regs,mem,w,_=c.execute(code[pc:pc+8],regs,mem);writes|=w;pc+=8
    return regs,mem,writes,branches

def prove(code):
    c.need(z.get_version_string()=='5.1.0','solver pin')
    p00,p10,p01,p11=z.BitVecs('p00 p10 p01 p11',64)
    low=lambda v:z.ZeroExt(32,z.Extract(31,0,v))
    high=lambda v:z.LShR(v,32)
    initial=[z.BitVec('entry_r'+str(i),64) for i in range(11)]
    initial[0]=p00;initial[1]=low(p10)+high(p00)
    initial[2]=high(p10)+low(p11);initial[4]=p01<<32
    initial[5]=low(initial[1]);initial[7]=p01;initial[8]=z.BitVecVal(1,64)
    memory={-0x150:p00,-0xe0:p11,-0xa8:initial[5],-0xd8:z.BitVec('incoming_start_high',64),-0x108:z.BitVecVal(1,64)}
    r,m,w,b=execute(code,initial,memory)
    c.need(w=={-0x148,-0xa8,-0x170,-0x180,-0x178,-0x108},'carry write inventory')
    # Reconstruct the still-distributed result; upper carry is accumulated later in the handler.
    top=high(p11)+r[8]+m[-0x148]+r[7]+m[-0x108]
    got=z.Concat(z.Extract(31,0,top),z.Extract(31,0,r[1]),z.Extract(31,0,m[-0x180]),z.Extract(31,0,p00))
    ext=lambda v:z.ZeroExt(64,v)
    want=ext(p00)+(ext(p10)<<32)+(ext(p01)<<32)+(ext(p11)<<64)
    properties=[got==want,r[3]==initial[3],r[6]==initial[6],r[10]==initial[10]]
    properties += [m[k]==v for k,v in memory.items() if k not in (-0xa8,-0x108)]
    # Prove the column representation equals the original full-width sum,
    # then connect every output limb to it. The column carries are derived
    # from arbitrary partial products. The incoming stack flag is required to
    # be 1 and is separately proved from the actual entry path by link-product.
    column1=high(p00)+low(p10)+low(p01)
    column2=high(p10)+high(p01)+low(p11)+high(column1)
    column3=high(p11)+high(column2)
    columns=z.Concat(z.Extract(31,0,column3),z.Extract(31,0,column2),z.Extract(31,0,column1),z.Extract(31,0,p00))
    obligations=[columns==want]
    obligations += [z.Extract(i+31,i,got)==z.Extract(i+31,i,columns) for i in range(0,128,32)]
    obligations += properties[1:]
    for property in obligations:
        s=z.Tactic('qfbv').solver();s.set(timeout=30000);s.add(z.Not(property))
        result=s.check();c.need(result!=z.unknown,'UNKNOWN: '+s.reason_unknown())
        if result==z.sat:break
    out={'result':str(result),'instructions':len(code)//8,'conditionalSkips':b,'writes':sorted(w)}
    if result==z.sat:
        model=s.model();out['partialProducts']={str(v):model.eval(v,model_completion=True).as_long() for v in (p00,p10,p01,p11)}
        out['actual']=model.eval(got,model_completion=True).as_long();out['expected']=model.eval(want,model_completion=True).as_long()
    return out
