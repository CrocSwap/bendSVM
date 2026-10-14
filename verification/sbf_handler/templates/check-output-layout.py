"""SBF-target native output layout used by the independent byte oracle."""
from pathlib import Path
import hashlib,json,os,subprocess
base=Path(__file__).resolve().parent;repo=base.parents[1]
clang=Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin')))/'clang'
t='bend_vesting_2e_Outcome_t';effect='as.c0.f1.as.c0.f0'
fields=[('tag','tag',0),('rejectionCode','as.c1.f0',4),('state','as.c0.f0',4),('effects','as.c0.f1',132),('effectTag',effect+'.tag',136),('sourceRole',effect+'.as.c1.f0',140),('destinationRole',effect+'.as.c1.f1',144),('custodyRole',effect+'.as.c1.f2',148),('mint',effect+'.as.c1.f3',152),('recipientTag',effect+'.as.c1.f4.tag',188),('recipientOwner',effect+'.as.c1.f4.as.c2.f0',192),('amountTag',effect+'.as.c1.f5.tag',228),('amountLow',effect+'.as.c1.f5.as.c0.f0',232),('amountHigh',effect+'.as.c1.f5.as.c0.f1',236),('authority',effect+'.as.c1.f6.tag',240),('secondEffect','as.c0.f1.as.c0.f1',248),('claimedLow','as.c0.f0.as.c1.f0.as.c0.f5.as.c0.f0',124),('claimedHigh','as.c0.f0.as.c1.f0.as.c0.f5.as.c0.f1',128)]
source='#include "vesting.h"\n'+''.join(f'_Static_assert(__builtin_offsetof({t}, {member}) == {offset}, "{name}");\n' for name,member,offset in fields)+f'_Static_assert(sizeof({t}) == 360, "output size");\n'
p=base/'output-layout.c';p.write_text(source);cmd=[str(clang),'--target=sbf','-mcpu=generic','-std=c17','-Ibuild','-fsyntax-only',str(p)]
r=subprocess.run(cmd,cwd=repo,capture_output=True,text=True,timeout=30);positive=base/'output-layout.log';positive.write_text(r.stdout+r.stderr)
if r.returncode:raise RuntimeError(r.stderr)
bad=base/'output-layout-wrong.c';bad.write_text(source.replace('== 248, "secondEffect"','== 252, "secondEffect"'))
r=subprocess.run(cmd[:-1]+[str(bad)],cwd=repo,capture_output=True,text=True,timeout=30);negative=base/'output-layout-wrong.log';negative.write_text(r.stdout+r.stderr)
if not r.returncode or 'static assertion failed' not in r.stderr or 'secondEffect' not in r.stderr:raise RuntimeError('wrong second effect layout accepted')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'fields':[{'name':n,'member':m,'offset':o} for n,m,o in fields],'size':360,'wrongOffsetRefused':True,'inputHashes':{str(p):sha(p) for p in [Path(__file__),repo/'build/vesting.h',repo/'examples/vesting/vesting.bend',repo/'sdk/effects.bend',clang]},'evidenceHashes':{str(p):sha(p) for p in [p,bad,positive,negative]},'scope':'Target C offsetof/sizeof bindings for independently constructed native-output oracle; no source extraction/compiler/VM proof.'}
out=base/'output-layout-report.json';out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'fields':len(fields),'size':360}))
