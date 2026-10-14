"""Control-flow boundary/route tests independent of the vesting fixture."""
from pathlib import Path
import struct,subprocess,sys
import sbf_cfg as cfg
I=lambda op=0xb7,ds=0,off=0,imm=0:struct.pack('<BBhi',op,ds,off,imm)

def check():
    refusals=[]
    def refuse(name,fn,reason):
        try:fn()
        except ValueError as e:
            if str(e)!=reason:raise RuntimeError((name,str(e),reason))
        else:raise RuntimeError('accepted '+name)
        refusals.append(name)
    exit=I(0x95)
    for name,text,address,reason in [
        ('empty',b'',0,'text instruction alignment'),
        ('partial instruction',exit[:-1],0,'text instruction alignment'),
        ('unaligned address',exit,1,'text address'),
        ('negative address',exit,-8,'text address'),
        ('overflow address',exit,2**64,'text address'),
        ('truncated lddw',I(0x18),0,'truncated double instruction'),
        ('lddw continuation opcode',I(0x18)+I(1)+exit,0,'double continuation fields'),
        ('lddw continuation registers',I(0x18)+I(0,1)+exit,0,'double continuation fields'),
        ('lddw continuation offset',I(0x18)+I(0,0,1)+exit,0,'double continuation fields'),
        ('past end jump',I(5,off=1)+exit,0,'edge target is not an instruction'),
        ('before start jump',I(5,off=-2)+exit,0,'edge target is not an instruction'),
        ('jump into continuation',I(5,off=1)+I(0x18)+I(0)+exit,0,'edge target is not an instruction'),
        ('fallthrough end',I(),0,'edge target is not an instruction'),
    ]:refuse(name,lambda text=text,address=address:cfg.decode(text,address),reason)
    linear=I()+exit
    refuse('entry inside instruction',lambda:cfg.acyclic_cone(linear,0,1,8),'instruction cutpoints')
    refuse('stop outside text',lambda:cfg.acyclic_cone(linear,0,0,16),'instruction cutpoints')
    refuse('unreachable cutpoint',lambda:cfg.acyclic_cone(exit+exit,0,0,8),'no graph route')
    refuse('conditional cycle',lambda:cfg.acyclic_cone(I(0x15,off=-1)+exit,0,0,8),'cyclic cone')
    refuse('call in cone',lambda:cfg.acyclic_cone(I(0x85)+exit,0,0,8),'unsupported path opcode 0x85')
    refuse('indirect call in cone',lambda:cfg.acyclic_cone(I(0x8d)+exit,0,0,8),'unsupported path opcode 0x8d')
    # A branch diamond retains both alternatives and their merge, at relocated addresses.
    text=I(0x15,off=2)+I()+I(5,off=1)+I()+exit
    _,edges,cone=cfg.acyclic_cone(text,0x100,0x100,0x120)
    assert cone=={0x100,0x108,0x110,0x118,0x120}
    assert edges[0x100]==[0x118,0x108] and edges[0x120]==[]
    # Conditional off=0 has two distinct edge labels even with one destination.
    _,edges,cone=cfg.acyclic_cone(I(0x15)+exit,0,0,8)
    assert edges[0]==[8,8] and cone=={0,8}
    # The LDDW second word is data; its high immediate may contain arbitrary bits.
    ins,edges,cone=cfg.acyclic_cone(I(0x18)+I(0,imm=-1)+exit,0,0,16)
    assert set(ins)=={0,16} and edges[0]==[16] and cone=={0,16}
    # A non-reaching arm may contain a call. It is outside this conditional theorem.
    _,edges,cone=cfg.acyclic_cone(I(0x15,off=2)+I(0x85)+exit+I()+exit,0,0,32)
    assert cone=={0,24,32} and edges[0]==[24,8]
    # The exclusive stop may itself be a call, since it is never executed.
    _,edges,cone=cfg.acyclic_cone(I()+I(0x85)+exit,0,0,8)
    assert cone=={0,8} and edges[8]==[]
    # Independent enumerated acyclic graph paths agree with cone membership.
    checked=0
    for a in range(1,5):
        for b in range(2,5):
            code=I(0x15,off=a-1)+I(0x15,off=b-2)+I()+I()+exit
            _,_,cone=cfg.acyclic_cone(code,0,0,32)
            expected=set()
            def walk(node,path):
                if node==4:expected.update(path+[node]);return
                destinations=([a,1] if node==0 else [b,2] if node==1 else [node+1])
                for target in destinations:walk(target,path+[node])
            walk(0,[])
            assert cone=={n*8 for n in expected};checked+=1
    p=subprocess.run([sys.executable,'-O',str(Path(cfg.__file__))],capture_output=True,text=True,timeout=10)
    assert p.returncode!=0 and 'assertions required' in p.stderr
    return {'passed':True,'refusals':refusals,'enumeratedGraphs':checked,'optimizedPythonRefused':True}
