"""Synthetic ELF boundary and identity controls; no loader claim."""
from pathlib import Path
import struct,subprocess,sys
import sbf_elf as elf

def check():
    names=b'\0.text\0.shstrtab\0';text=struct.pack('<BBhi',0x95,0,0,0)
    header=[b'\x7fELF\x02\x01\x01'+b'\0'*9,3,263,1,0x100,0,128,0,64,0,0,64,3,2]
    sections=[[0]*10,[1,1,6,0x100,64,len(text),0,0,8,0],[7,3,0,0,72,len(names),0,0,1,0]]
    def make(h=None,ss=None,n=names):
        raw=bytearray(320);struct.pack_into('<16sHHIQQQIHHHHHH',raw,0,*(h or header))
        raw[64:72]=text;raw[72:72+len(n)]=n
        for i,s in enumerate(ss or sections):struct.pack_into('<IIQQQQIIQQ',raw,128+i*64,*s)
        return raw
    valid=make();assert elf.text_section(valid)==(0x100,text)
    rows=[]
    def refuse(name,raw,reason):
        try:elf.text_section(raw)
        except ValueError as e:
            if str(e)!=reason:raise RuntimeError((name,str(e),reason))
        else:raise RuntimeError('accepted '+name)
        rows.append(name)
    refuse('truncated header',valid[:63],'ELF header')
    for name,index,value,reason in [
        ('class',0,b'\x7fELF\x01\x01\x01'+b'\0'*9,'expected SBPFv0 ELF64 little endian'),
        ('endian',0,b'\x7fELF\x02\x02\x01'+b'\0'*9,'expected SBPFv0 ELF64 little endian'),
        ('type',1,2,'expected SBPFv0 ELF64 little endian'),
        ('machine',2,247,'expected SBPFv0 ELF64 little endian'),
        ('version',3,2,'expected SBPFv0 ELF64 little endian'),
        ('flags',7,1,'expected SBPFv0 ELF64 little endian'),
        ('header size',8,63,'expected SBPFv0 ELF64 little endian'),
        ('table bounds',6,320,'section table'),
        ('table overlap header',6,0,'section table'),
        ('table alignment',6,127,'section table'),
        ('entry size',11,63,'section table'),
        ('empty sections',12,0,'section table'),
        ('invalid names index',13,3,'section table'),
        ('null names index',13,0,'section table'),
    ]:
        h=list(header);h[index]=value;refuse(name,make(h=h),reason)
    for name,section,index,value,reason in [
        ('names type',2,1,1,'section string table'),
        ('names bounds',2,5,999,'section string table'),
        ('empty names',2,5,0,'section string table'),
        ('bad name offset',1,0,999,'section name'),
        ('duplicate text',2,0,1,'unique text section'),
        ('missing text',1,0,0,'unique text section'),
        ('non-progbits text',1,1,8,'executable text section'),
        ('nonexecuting text',1,2,2,'executable text section'),
        ('writable text',1,2,7,'executable text section'),
        ('bad alignment',1,8,3,'executable text section'),
        ('text entry size',1,9,8,'executable text section'),
        ('empty text',1,5,0,'text bounds'),
        ('partial text instruction',1,5,7,'text bounds'),
        ('text file bounds',1,5,9992,'text bounds'),
        ('text header overlap',1,4,56,'text bounds'),
        ('text address overflow',1,3,2**64-8,'text bounds'),
        ('text table overlap',1,4,128,'text metadata overlap'),
        ('text names overlap',1,4,72,'text metadata overlap'),
    ]:
        ss=[list(s) for s in sections];ss[section][index]=value
        # Last aligned address plus one instruction is allowed; make it overflow.
        if name=='text address overflow':ss[1][5]=16
        refuse(name,make(ss=ss),reason)
    refuse('unterminated names',make(n=names[:-1]+b'x'),'section string termination')
    refuse('names initial zero',make(n=b'x'+names[1:]),'section string termination')
    # Relocation of the text section's virtual address does not alter byte extraction.
    ss=[list(s) for s in sections];ss[1][3]=0x800
    assert elf.text_section(make(ss=ss))==(0x800,text)
    child=subprocess.run([sys.executable,'-O',str(Path(elf.__file__))],capture_output=True,text=True,timeout=10)
    assert child.returncode!=0 and 'assertions required' in child.stderr
    return {'passed':True,'refusals':rows,'optimizedPythonRefused':True}
