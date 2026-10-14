import os
"""Bind generated C and recorded source closure to the exact analyzed ELF."""
from pathlib import Path
import hashlib,json,subprocess,os
from fresh_source import build_fresh
if not __debug__:raise RuntimeError('assertions required')
base=Path(__file__).resolve().parent;root=base.parents[1];sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
mfile=root/'build/vesting.manifest.json';manifest=json.loads(mfile.read_text())
if manifest['source']!='examples/vesting/PROOF.bend' or manifest['root']!='vesting.process':raise RuntimeError('source identity')
if manifest['bendCommit']!='7561656155a4285c1e4ccfcb3505ab59524de973' or manifest['platformTools']!='v1.53' or manifest['sbpfVersion']!=0:raise RuntimeError('toolchain identity')
inputs=[];drift=[]
for name,h in manifest['inputs'].items():
 p=Path(name)
 if p.is_absolute() or '..' in p.parts:raise RuntimeError('nonlocal manifest input')
 f=root/p;inputs.append(f)
 if sha(f)!=h:drift.append(name)
# Package command registration changed after this build; executable/source inputs may not drift.
if drift not in [[],['package.json']]:raise RuntimeError('recorded source drift: '+str(drift))
for suffix in ['.h','.c','.wire.h','.dispatch.h','.so']:
 p=root/('build/vesting'+suffix)
 if sha(p)!=manifest['artifacts'][suffix]:raise RuntimeError('generated artifact mismatch '+suffix)
 inputs.append(p)
slice_elf=root/'build/sbf-slice-probe/vesting.so'
if sha(slice_elf)!=manifest['artifacts']['.so']:raise RuntimeError('proof ELF differs from manifest')
tools=Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin')));clang=tools/'clang';ld=tools/'ld.lld'
version=subprocess.check_output([str(clang),'--version'],text=True)
if manifest['compiler'] not in version or '20.1.7' not in version or 'anza-xyz' not in version:raise RuntimeError('compiler version')
inputs += [mfile,slice_elf,Path(__file__),base/'fresh_source.py',clang,ld];bound={str(p):sha(p) for p in inputs}
out=base/'artifacts';out.mkdir(exist_ok=True)
flags=['--target=sbf','-mcpu=generic','-O2','-fPIC','-ffreestanding','-fno-builtin','-fno-stack-protector','-std=c17','-Wall','-Wextra','-Werror','-Wframe-larger-than=4096','-fstack-usage','-ffunction-sections','-fdata-sections','-Ibuild','-Iruntime']
commands=[[str(clang),*flags,'-c','build/vesting.c','-o',str(out/'vesting.o')],[str(clang),*flags,'-c','runtime/memory.c','-o',str(out/'vesting.memory.o')],[str(ld),'-z','notext','-shared','--Bdynamic','runtime/sbf.ld','--entry','entrypoint','-z','max-page-size=4096','--gc-sections',str(out/'vesting.o'),str(out/'vesting.memory.o'),'-o',str(out/'vesting.so')]]
logs=[]
for command in commands:
 p=subprocess.run(command,cwd=root,capture_output=True,text=True,timeout=60);logs.append(p.stdout+p.stderr)
 if p.returncode:raise RuntimeError(p.stderr)
log=out/'build.log';log.write_text(''.join(logs))
if sha(out/'vesting.so')!=sha(slice_elf):raise RuntimeError('rebuilt ELF is not byte identical')
if bound!={str(p):sha(p) for p in inputs}:raise RuntimeError('input drift during rebuild')
fresh=build_fresh(root,manifest,os.environ['SBF_CHAIN_DEPENDENCY_ROOT'])
report={'freshSourceBuild':fresh,'passed':True,'exploratory':True,'endToEndVerified':False,'inputHashes':bound,'source':manifest['source'],'root':manifest['root'],'recordedInputDrift':drift,'compilerVersion':version,'commands':commands,'byteIdentical':True,'elfSha256':sha(slice_elf),'outputHashes':{str(p):sha(p) for p in sorted(out.iterdir())},'scope':'Manifest-bound emitted C/header/runtime recompilation yields the exact ELF analyzed by the machine proofs. All recorded source inputs match except explicitly disclosed package command metadata. A fresh normal public Bend build rechecks the source proof gate and reproduces the same C/header/wire/dispatch/ELF. This does not prove Clang/LLD, ABI, whole-handler semantics, division or account commit.'}
(base/'artifact-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'byteIdentical':True,'sourceInputs':len(manifest['inputs']),'recordedInputDrift':drift}))
