"""Fresh normal public build; dependencies shared read-only, outputs isolated."""
from pathlib import Path
import hashlib,json,os,subprocess

def build_fresh(root, manifest, dependency_root):
 sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
 dependency_root=Path(dependency_root).resolve()
 bend=dependency_root/'.deps/bend';bun=dependency_root/'node_modules/.bin/bun'
 def clean_pin():
  commit=subprocess.check_output(['git','-C',str(bend),'rev-parse','HEAD'],text=True).strip()
  dirty=subprocess.check_output(['git','-C',str(bend),'status','--porcelain'],text=True)
  if commit!='7561656155a4285c1e4ccfcb3505ab59524de973' or dirty:raise RuntimeError('fresh Bend pin/cleanliness')
  return commit
 commit=clean_pin()
 if subprocess.check_output([str(bun),'--version'],text=True).strip()!='1.4.2':raise RuntimeError('fresh Bun pin')
 target=root/'build/sbf-product-chain/fresh-build';target.mkdir()
 sources={}
 for relative in manifest['inputs']:
  if relative.startswith('.deps/'):continue
  raw=(root/relative).read_bytes();dest=target/relative;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw);sources[relative]=sha(dest)
 (target/'.deps').mkdir();(target/'.deps/bend').symlink_to(bend,target_is_directory=True)
 (target/'node_modules').symlink_to(dependency_root/'node_modules',target_is_directory=True)
 for relative in manifest['inputs']:
  if relative.startswith('.deps/') and sha(target/relative)!=sha(root/relative):raise RuntimeError('fresh dependency source identity')
 command=[str(bun),'scripts/program.ts','examples/vesting/PROOF.bend','vesting.process','build/vesting']
 log=target/'build.log'
 with log.open('w') as output:
  result=subprocess.run(command,cwd=target,env=dict(os.environ,BEND_NO_TELEMETRY='1'),stdout=output,stderr=subprocess.STDOUT,timeout=180)
 if result.returncode:raise RuntimeError('fresh public build failed; see '+str(log))
 fresh=json.loads((target/'build/vesting.manifest.json').read_text())
 if fresh['source']!=manifest['source'] or fresh['root']!=manifest['root'] or fresh['bendCommit']!=commit:raise RuntimeError('fresh manifest identity')
 normalized={('.deps/bend/bend2/base.bend' if (target/r).resolve()==(bend/'bend2/base.bend').resolve() else r):h for r,h in fresh['inputs'].items()}
 if len(normalized)!=len(fresh['inputs']) or set(normalized)!=set(manifest['inputs']):raise RuntimeError('fresh source closure')
 for relative,h in fresh['inputs'].items():
  if sha(target/relative)!=h:raise RuntimeError('fresh source binding')
 for relative,h in normalized.items():
  if sha(root/relative)!=h:raise RuntimeError('fresh snapshot binding')
 for relative,h in sources.items():
  if sha(target/relative)!=h:raise RuntimeError('fresh source changed')
 expected={suffix:sha(root/('build/vesting'+suffix)) for suffix in ['.h','.c','.wire.h','.dispatch.h','.so']}
 for suffix,h in expected.items():
  if sha(target/('build/vesting'+suffix))!=h:raise RuntimeError('fresh output differs '+suffix)
 for suffix,h in fresh['artifacts'].items():
  if sha(target/('build/vesting'+suffix))!=h:raise RuntimeError('fresh artifact binding')
 receipt=fresh['sbfCallDepth'];rp=target/receipt['report']['path']
 if receipt['status']!='accepted' or sha(rp)!=receipt['report']['sha256']:raise RuntimeError('fresh call-depth receipt')
 clean_pin()
 files=[target/'build/vesting.manifest.json',log,rp]+[target/('build/vesting'+s) for s in fresh['artifacts']]+[target/r for r in fresh['inputs']]
 return {'passed':True,'command':command,'exitCode':result.returncode,'bendCommit':commit,'bunVersion':'1.4.2','matchedArtifacts':expected,'outputHashes':{str(p):sha(p) for p in files}}
