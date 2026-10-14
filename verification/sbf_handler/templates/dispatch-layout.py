"""Target-layout evidence for the operand trace, not a register-provenance proof."""
from pathlib import Path
import hashlib,json,os,subprocess
base=Path(__file__).resolve().parent;root=base.parents[1]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
clang=Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin')))/'clang'
state='bend_vesting_2e_State_t';context='bend__2e__2e__2f__2e__2e__2f_sdk_2f_context_2e_Context_t'
rows=[]
for field,index,offset in [('total',2,0x54),('start',3,0x60),('end',4,0x6c),('claimed',5,0x78)]:
 for limb in range(2):rows.append({'name':field+['Low','High'][limb],'type':state,'member':f'as.c1.f0.as.c0.f{index}.as.c0.f{limb}','offset':offset+4*limb})
for limb in range(2):rows.append({'name':'now'+['Low','High'][limb],'type':context,'member':f'as.c0.f2.as.c0.f{limb}','offset':0x30+4*limb})
instruction='bend_vesting_2e_Instruction_t'
for field,index,offset in [('total',2,80),('start',3,92),('end',4,104)]:
 for limb in range(2):rows.append({'name':'init'+field+str(limb),'type':instruction,'member':f'as.c0.f{index}.as.c0.f{limb}','offset':offset+4*limb})
rows.append({'name':'initTag','type':instruction,'member':'tag','offset':0})
files=[root/'build/vesting.h',root/'examples/vesting/vesting.bend',root/'sdk/context.bend',clang,Path(__file__)]
before={str(p):sha(p) for p in files}
source='#include "vesting.h"\n'+''.join(f'_Static_assert(__builtin_offsetof({r["type"]}, {r["member"]}) == {r["offset"]}, "{r["name"]}");\n' for r in rows)
source += f'_Static_assert(sizeof({context}) == 56, "context size");\n_Static_assert(sizeof({state}) == 128, "state size");\n_Static_assert(sizeof(bend_vesting_2e_Instruction_t) == 112, "instruction size");\n'
p=base/'layout.c';p.write_text(source)
command=[str(clang),'--target=sbf','-mcpu=generic','-std=c17','-Ibuild','-fsyntax-only',str(p)]
r=subprocess.run(command,cwd=root,capture_output=True,text=True,timeout=30);(base/'positive.log').write_text(r.stdout+r.stderr)
if r.returncode:raise RuntimeError(r.stderr)
fault=base/'wrong-layout.c';fault.write_text(source.replace('== 120, "claimedLow"','== 124, "claimedLow"'))
if fault.read_text()==source:raise RuntimeError('fault did not change source')
r=subprocess.run(command[:-1]+[str(fault)],cwd=root,capture_output=True,text=True,timeout=30);(base/'negative.log').write_text(r.stdout+r.stderr)
if not r.returncode or 'claimedLow' not in r.stderr or 'static assertion failed' not in r.stderr:raise RuntimeError('wrong layout accepted or wrong refusal')
if before!={str(p):sha(p) for p in files}:raise RuntimeError('input drift')
out={'passed':True,'exploratory':True,'inputHashes':before,'fields':rows,'positiveCommand':command,'wrongOffsetRefused':True,'evidenceHashes':{str(p):sha(p) for p in [base/'layout.c',base/'wrong-layout.c',base/'positive.log',base/'negative.log']},'scope':'Seventeen SBF-target field offsets in actual emitted C types. Actual native entry path and division frame-preservation checks separately connect total/claimed offsets to payout stack words. Function pointer ABI, valid disjoint memory and source constructor interpretation remain conditional.'}
(base/'layout-report.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'passed':True,'offsetAssertions':len(rows),'wrongOffsetRefused':True}))
