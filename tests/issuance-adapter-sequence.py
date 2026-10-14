"""Execute the complete emitted adapter with framed host syscall stubs.

Checks commit ordering and later effect inputs, not SPL execution or rollback.
"""
from pathlib import Path
import hashlib,json,os,re,shutil,subprocess,uuid
root=Path.cwd();base=root/'build/issuance-adapter-sequence';run=base/'runs'/str(uuid.uuid4());run.mkdir(parents=True)
latest=base/'fresh-receipt.json'
if latest.exists():latest.rename(run/'previous.json')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def need(value,reason):
 if not value:raise RuntimeError(reason)
def command(args,log,wanted):
 p=subprocess.run(args,capture_output=True,text=True,timeout=120,env={**os.environ,'ASAN_OPTIONS':'detect_leaks=0:abort_on_error=1','UBSAN_OPTIONS':'halt_on_error=1'})
 log.write_text(p.stdout+p.stderr);need(p.returncode==wanted,('command failed',args,p.returncode,p.stderr));return p
try:
 if not __debug__:raise RuntimeError('assertions required')
 # An explicit input is useful for a separately exported checked fixture.
 # Both modes enforce that fixture's complete recorded source/artifact hashes.
 explicit=os.environ.get('ISSUANCE_NATIVE_INPUT')
 if explicit:input_file=Path(explicit)
 else:
  receipt=json.loads(Path('build/issuance-adapter/fresh-receipt.json').read_text())
  need(receipt['passed'] is True,'qualification status');input_file=Path(receipt['inputArtifact']);need(sha(input_file)==receipt['inputSha256'],'qualification input binding')
 raw=input_file.read_bytes();data=json.loads(raw);bindings={**data['sourceHashes'],**data['artifactHashes']}
 for p,h in bindings.items():need(sha(p)==h,('stale fixture',p))
 fixture=input_file.parent;original=(fixture/'issuance.c').read_text()
 need(original==data['fixture']['files']['issuance.c'],'adapter binding')
 template=Path(__file__).with_suffix('.c');controller=Path(__file__).resolve();own={str(p):sha(p) for p in [controller,template]}
 matches=re.findall(r'const u8 header\[20\] = (\{[^}]+\});',original);need(len(matches)==1,'unique state header')
 harness=template.read_text();need(harness.count('HEADER_SETUP')==1,'header placeholder')
 harness=harness.replace('HEADER_SETUP','const u8 expected_header[20] = '+matches[0]+';')
 cc=shutil.which(os.environ.get('CC','clang'));need(cc is not None,'host C compiler')
 version=command([cc,'--version'],run/'compiler.log',0).stdout
 (run/'native.c').write_text(harness)
 def compile(directory):
  return command([cc,'-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all','-I'+str(fixture.resolve()),'-I'+str(root/'runtime'),str(directory/'native.c'),'-o',str(directory/'native')],directory/'compile.log',0)
 compile(run);baseline=command([str(run/'native')],run/'baseline.log',0);need(not baseline.stderr,'native baseline stderr')
 lines=baseline.stdout.splitlines();need(lines[-1]=='16 adapter sequences passed','case completion')
 cases=[json.loads(line) for line in lines[:-1]]
 expected=[{'initialize':i,'wide':w,'failAt':f,'calls':f or 3,'result':18 if f else 0,'returns':0 if f else 1,'counter':(0 if i else 0xffffffff) if f else (1 if i else 0)} for i in range(2) for w in range(2) for f in range(4)]
 need(cases==expected,'case oracle')
 def fault(directory,name,extra,condition):
  p=command([str(directory/'native'),*extra],directory/(name+'.log'),42)
  wanted=[i+1 for i,line in enumerate(harness.splitlines()) if condition in line]
  need(len(wanted)==1 and p.stderr.strip()==f'check failed at line {wanted[0]}','wrong fault reason')
  return {'name':name,'exitCode':42,'line':wanted[0]}
 controls=[fault(run,'unframed-decimals',['fault'],'REQUIRE(read_le(ix->data+1,8)==amounts[calls]')]
 mutation=run/'early-commit';mutation.mkdir();commit='  __builtin_memcpy(state.data, header, 20);\n  __builtin_memcpy(state.data + 20, encoded, 5);\n';anchor='  for (unsigned i = 0; i < 3; ++i) {\n    if (bend_transfer_execute'
 need(original.count(commit)==1 and original.count(anchor)==1,'unique commit fault')
 (mutation/'issuance.c').write_text(original.replace(commit,'').replace(anchor,commit+anchor));(mutation/'native.c').write_text(harness);compile(mutation)
 controls.append(fault(mutation,'early-commit',[],'REQUIRE(memcmp(bytes[0],initial_state,25)==0);'))
 need(input_file.read_bytes()==raw,'input drift')
 for p,h in {**bindings,**own}.items():need(sha(p)==h,('source drift',p))
 report={'passed':True,'endToEndVerified':False,'input':str(input_file),'inputSha256':sha(input_file),'sourceHashes':bindings,'checkerHashes':own,'compiler':{'path':cc,'sha256':sha(cc),'version':version},'cases':cases,'controls':controls,'artifacts':{str(p):sha(p) for p in run.rglob('*') if p.is_file()},'scope':'Complete emitted host-C adapter and executor with framed syscall stub under ASan/UBSan. Actual token program, runtime rollback, disjoint-loader validity and SBF semantics are outside this check.'}
 pending=run/'report.json';pending.write_text(json.dumps(report,indent=2)+'\n');temp=run/'publish.json';temp.write_bytes(pending.read_bytes());temp.replace(latest);print(json.dumps({'passed':True,'cases':len(cases),'controls':len(controls),'report':str(latest),'sha256':sha(latest)}))
except BaseException as error:
 (run/'failure.json').write_text(json.dumps({'passed':False,'error':str(error)},indent=2)+'\n');raise
