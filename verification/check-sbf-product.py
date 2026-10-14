"""Fresh source-to-artifact qualification of the conditional vesting SBF product.

All executable proof templates are maintained source. UUID outputs are isolated;
no historical build artifact or ignored probe script is required. The generated
ELF must satisfy the fixture-specific structural/semantic assertions. This is
not a whole-handler theorem or a verified compiler.
"""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,sys,uuid
repo=Path(__file__).resolve().parents[1]
base=repo/'verification/sbf_product'
output=Path(os.environ.get('SBF_PRODUCT_OUTPUT',str(repo/'build/sbf-product'))).resolve()
run=output/'runs'/str(uuid.uuid4());run.mkdir(parents=True)
latest=output/'latest.json'
if latest.exists():os.replace(latest,run/'previous-latest.json')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()

def command(args,cwd,log,env=None,timeout=240):
 with log.open('w') as f:
  result=subprocess.run(args,cwd=cwd,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=timeout)
 if result.returncode:raise RuntimeError('command failed: '+str(log))

try:
 if not __debug__:raise RuntimeError('assertions required')
 stage=run/'source';stage.mkdir()
 inventory=json.loads((base/'source-inputs.json').read_text())
 templates=json.loads((base/'templates.json').read_text())
 files=[Path(__file__).relative_to(repo).as_posix(),'verification/sbf_product/source-inputs.json','verification/sbf_product/templates.json']
 files += ['verification/'+n for n in ['sbf_machine.py','sbf_cfg.py','sbf_paths.py','sbf_elf.py']]
 files += ['verification/sbf_product/'+p for p in templates]
 files += [p for p in inventory if not p.startswith('.deps/')]
 bindings={str(repo/p):sha(repo/p) for p in files}
 for relative in files:
  dest=stage/relative;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes((repo/relative).read_bytes())
 for source,destination in templates.items():
  dest=stage/destination;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes((base/source).read_bytes())
 staged={str(stage/p):bindings[str(repo/p)] for p in files}
 staged.update({str(stage/d):sha(base/s) for s,d in templates.items()})
 if staged!={p:sha(p) for p in staged}:raise RuntimeError('staging source mismatch')
 # Sparse local clone: independent clean checkout, shared immutable Git objects.
 # This avoids copying the dependency's large media/history into every proof run.
 bend=repo/'.deps/bend';pin='7561656155a4285c1e4ccfcb3505ab59524de973'
 def pinned():
  return subprocess.check_output(['git','-C',str(bend),'rev-parse','HEAD'],text=True).strip()==pin and not subprocess.check_output(['git','-C',str(bend),'status','--porcelain'],text=True)
 if not pinned():raise RuntimeError('Bend dependency must be clean and pinned')
 (stage/'.deps').mkdir();clone=stage/'.deps/bend'
 command(['git','clone','--quiet','--shared','--no-checkout',str(bend),str(clone)],repo,run/'clone.log')
 command(['git','sparse-checkout','set','bend2'],clone,run/'sparse.log')
 command(['git','checkout','--quiet','--detach',pin],clone,run/'checkout.log')
 (stage/'node_modules').symlink_to(repo/'node_modules',target_is_directory=True)
 runner=repo/'target/debug/bend-test-runner'
 if not runner.is_file():raise RuntimeError('Build target/debug/bend-test-runner before this gate')
 (stage/'target/debug').mkdir(parents=True);(stage/'target/debug/bend-test-runner').symlink_to(runner)
 bun=repo/'node_modules/.bin/bun'
 if subprocess.check_output([str(bun),'--version'],text=True).strip()!='1.4.2':raise RuntimeError('Bun pin')
 tools=Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin')))
 external={str(p):sha(p) for p in [runner,bun,tools/'clang',tools/'ld.lld',Path(sys.executable)]}
 env=dict(os.environ,BEND_NO_TELEMETRY='1',SBF_TOOLS=str(tools))
 command([str(bun),'scripts/program.ts','examples/vesting/PROOF.bend','vesting.process','build/vesting'],stage,run/'source-build.log',env)
 manifest=json.loads((stage/'build/vesting.manifest.json').read_text())
 if sorted(manifest['inputs'])!=inventory:raise RuntimeError('fresh source inventory changed; review source-inputs.json')
 for relative,h in manifest['inputs'].items():
  if sha(stage/relative)!=h:raise RuntimeError('fresh manifest source binding')
 for suffix,h in manifest['artifacts'].items():
  if sha(stage/('build/vesting'+suffix))!=h:raise RuntimeError('fresh artifact binding')
 shutil.copyfile(stage/'build/vesting.so',stage/'build/sbf-slice-probe/vesting.so')
 # The old snapshot machinery now receives only fresh artifacts and maintained templates.
 chain=run/'qualification'
 command([sys.executable,str(stage/'build/sbf-product-chain/run.py')],stage,run/'qualification.log',dict(env,SBF_CHAIN_SOURCE_ROOT=str(stage),SBF_CHAIN_OUTPUT_ROOT=str(chain)),timeout=600)
 pointer=json.loads((chain/'latest.json').read_text());terminal=Path(pointer['runRoot'])/'terminal.json'
 if sha(terminal)!=pointer['terminalSha256']:raise RuntimeError('terminal binding')
 accepted=json.loads(terminal.read_text())
 if accepted['passed'] is not True or accepted['endToEndVerified'] is not False or len(accepted['phases'])!=7:raise RuntimeError('qualification status')
 if staged!={p:sha(p) for p in staged}:raise RuntimeError('staged source drift')
 if subprocess.check_output(['git','-C',str(clone),'rev-parse','HEAD'],text=True).strip()!=pin or subprocess.check_output(['git','-C',str(clone),'status','--porcelain'],text=True):raise RuntimeError('staged Bend drift')
 if bindings!={p:sha(p) for p in bindings} or external!={p:sha(p) for p in external} or not pinned():raise RuntimeError('source or dependency drift')
 report={'passed':True,'endToEndVerified':False,'sourceHashes':bindings,'stagedSourceHashes':staged,'externalHashes':external,'terminal':str(terminal),'terminalSha256':sha(terminal),'initialManifest':str(stage/'build/vesting.manifest.json'),'initialManifestSha256':sha(stage/'build/vesting.manifest.json'),'logs':{str(p):sha(p) for p in run.glob('*.log')},'scope':'Fresh maintained-source qualification of a conditional vesting native-entry arithmetic path, including source proof gate, identical C/SBF rebuild, path/product proofs and instrumented 244-instruction LiteSVM replay. Valid disjoint ABI memory, source-layout interpretation, restricted models and Z3 remain trusted. Whole-handler outputs, division, effects/commit and loader/JIT correctness are not proved.'}
 (run/'report.json').write_text(json.dumps(report,indent=2)+'\n')
 temp=run/'latest.tmp';temp.write_text(json.dumps({'runRoot':str(run),'reportSha256':sha(run/'report.json')},indent=2)+'\n');os.replace(temp,latest)
 print(json.dumps({'passed':True,'runRoot':str(run),'reportSha256':sha(run/'report.json')}))
except BaseException as e:
 (run/'failure.json').write_text(json.dumps({'passed':False,'error':str(e)},indent=2)+'\n')
 raise
