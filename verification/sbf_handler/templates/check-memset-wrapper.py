"""Emitted libc wrapper correspondence under an explicit Solana syscall contract."""
from pathlib import Path
import hashlib,json,os,re,struct,subprocess,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
import z3 as z
from sbf_elf import text_section
if not __debug__:raise RuntimeError('assertions required')
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes());start,end,site=0x6890,0x68b8,0x68a0;body=text[start-address:end-address]
readelf=Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin')))/'llvm-readelf'
relocations=subprocess.check_output([str(readelf),'-r',str(elf)],text=True);log=base/'memset-original-relocations.txt';log.write_text(relocations)
rows=re.findall(r'^([0-9a-f]{16})\s+[0-9a-f]+\s+(R_SBF_\S+)\s+[0-9a-f]+\s+(\S+)$',relocations,re.M)
def validate_relocations(rows):
 selected=[r for r in rows if start<=int(r[0],16)<end]
 if selected!=[(f'{site:016x}','R_SBF_64_32','sol_memset_')]:raise ValueError('wrapper syscall relocation')
validate_relocations(rows)
initial=[z.BitVec('wrapper_in_'+str(i),64) for i in range(11)]
def run(code):
 if len(code)!=end-start:raise ValueError('wrapper byte range')
 r=list(initial);calls=[];exited=False
 for index in range(0,len(code),8):
  at=start+index;op,ds,off,imm=struct.unpack_from('<BBhi',code,index);dst,src=ds&15,ds>>4
  if op==0xbf:
   if dst>=10 or src>=10 or off!=0 or imm!=0:raise ValueError('wrapper move shape')
   r[dst]=r[src]
  elif op==0x57:
   if dst>=10 or src!=0 or off!=0:raise ValueError('wrapper mask shape')
   r[dst]=r[dst]&z.BitVecVal(imm,64)
  elif op==0x85:
   if at!=site or ds!=0x10 or off!=0 or imm!=-1 or calls:raise ValueError('wrapper external call shape')
   calls.append(tuple(r[1:4]))
   # Trusted syscall ABI: volatile registers arbitrary, nonvolatile registers preserved.
   for k in range(6):r[k]=z.BitVec('syscall_out_'+str(k),64)
  elif op==0x95:
   if index+8!=len(code) or ds!=0 or off!=0 or imm!=0:raise ValueError('wrapper exit shape')
   exited=True
  else:raise ValueError('unsupported wrapper opcode')
 if not exited or len(calls)!=1:raise ValueError('wrapper call/exit inventory')
 return r,calls[0]
def property(code):
 r,args=run(code)
 return z.And(args[0]==initial[1],args[1]==z.ZeroExt(56,z.Extract(7,0,initial[2])),args[2]==initial[3],r[0]==initial[1],r[10]==initial[10])
s=z.Solver();s.set(timeout=10000);s.add(z.Not(property(body)));result=s.check()
if result!=z.unsat:raise RuntimeError(('wrapper contract',str(result)))
faults=[]
for name,offset,value in [('truncate-to-seven-bits',8+4,0x7f),('return-volatile-pointer',24+1,0x10)]:
 bad=bytearray(body);bad[offset]=value;s=z.Solver();s.add(z.Not(property(bytes(bad))));result=s.check()
 if result!=z.sat:raise RuntimeError('missed '+name)
 faults.append({'name':name,'result':str(result),'witness':str(s.model())})
controls=[]
for name,changes,reason in [('unexpected-memory-store',[(0,0x7b)],'unsupported wrapper opcode'),('wrong-syscall-site-fields',[(16+1,0)],'wrapper external call shape'),('missing-return',[(32,0xbf)],'wrapper call/exit inventory')]:
 bad=bytearray(body)
 for off,value in changes:bad[off]=value
 try:run(bytes(bad))
 except ValueError as error:
  if str(error)!=reason:raise RuntimeError((name,str(error),reason))
 else:raise RuntimeError('accepted '+name)
 controls.append({'name':name,'reason':reason})
for name,changed in [('missing-relocation',[r for r in rows if int(r[0],16)!=site]),('wrong-syscall-name',[(r[0],r[1],'sol_memcpy_') if int(r[0],16)==site else r for r in rows]),('duplicate-relocation',rows+[(f'{site:016x}','R_SBF_64_32','sol_memset_')])]:
 try:validate_relocations(changed)
 except ValueError as error:controls.append({'name':name,'reason':str(error)})
 else:raise RuntimeError('accepted '+name)
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':[{'name':'exact emitted memset arguments and returned destination','result':'unsat'}],'instructions':len(body)//8,'syscall':'sol_memset_','faults':faults,'controls':controls,'inputHashes':{str(p):sha(p) for p in [Path(__file__),elf,repo/'verification/sbf_elf.py',repo/'runtime/memory.c',readelf]},'relocationEvidence':str(log),'relocationEvidenceSha256':sha(log),'scope':'Actual five-instruction wrapper forwards pointer/count, truncates value to8bits, returns original destination, performs no other memory accesses, and calls the exact bound sol_memset_ relocation. The syscall writes only the requested interval with the requested byte and preserves SBF nonvolatile registers by explicit trusted contract; VM CALL isolation/loader/syscall semantics are not formally verified.'}
file=base/'memset-wrapper-report.json';file.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'instructions':5,'faults':len(faults),'controls':len(controls)}))
