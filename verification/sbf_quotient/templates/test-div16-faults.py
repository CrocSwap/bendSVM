"""Actual emitted-ELF mutations must fail the intended universal step claim."""
from pathlib import Path
import hashlib,json,shutil,subprocess,sys,uuid
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
from sbf_elf import text_section
elf=repo/'build/sbf-slice-probe/vesting.so';raw=elf.read_bytes();address,text=text_section(raw);offset=raw.find(text)
if offset<0 or raw.find(text,offset+1)!=-1:raise RuntimeError('ambiguous text offset')
run=base/'div16-faults'/str(uuid.uuid4());run.mkdir(parents=True)
files=['prove-div16-first-two.py','prove-div16-steps-three-four.py','prove-div16-rest.py','check-div16-frame.py']
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest();sources={str(p):sha(p) for p in [Path(__file__),elf,*[base/n for n in files],repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py']}
cases=[('step'+str(i),at,0x57,'first inline step quotient/remainder' if i==1 else 'second inline step quotient/remainder' if i==2 else 'step '+str(i)+' quotient remainder guard','prove-div16-rest.py') for i,at in enumerate([0x4878,0x4a18,0x4bd8,0x4da8,0x4f60,0x5118,0x52d0,0x5490,0x5668,0x5820,0x59d8,0x5ba0],1)]
cases += [('frame-word-source',0x5c09,0x1a,'complete tagged next-callee input','check-div16-frame.py')]
rows=[]
for name,at,new,reason,driver in [('baseline',None,None,None,'prove-div16-rest.py')]+cases:
 stage=run/name;scout=stage/'build/sbf-division-scout';scout.mkdir(parents=True);(stage/'verification').symlink_to(repo/'verification',target_is_directory=True);(stage/'build/sbf-slice-probe').mkdir()
 for n in files:shutil.copyfile(base/n,scout/n)
 data=bytearray(raw)
 if at is not None:
  index=offset+at-address;old=data[index]
  if old!=(0x4a if name=='frame-word-source' else 0x47):raise RuntimeError('unexpected original byte')
  data[index]=new
 target=stage/'build/sbf-slice-probe/vesting.so';target.write_bytes(data)
 child=subprocess.run([sys.executable,'-B',str(scout/driver)],cwd=stage,capture_output=True,text=True,timeout=45)
 log=stage/'process.log';log.write_text(child.stdout+child.stderr)
 if name=='baseline':
  if child.returncode or json.loads(child.stdout)['passed'] is not True:raise RuntimeError('positive setup failed '+str(log))
 else:
  if child.returncode==0 or reason not in child.stderr or "'sat'" not in child.stderr:raise RuntimeError('wrong semantic failure '+str(log))
  if (scout/'div16-rest-report.json').exists():raise RuntimeError('fault published full success')
 rows.append({'name':name,'address':at,'newByte':new,'exitCode':child.returncode,'expectedReason':reason,'elf':str(target),'elfSha256':sha(target),'log':str(log),'logSha256':sha(log)})
for p,h in sources.items():
 if sha(p)!=h:raise RuntimeError('source drift')
report={'passed':True,'mutations':13,'baselinePassed':True,'rows':rows,'sourceHashes':sources,'scope':'Thirteen concrete emitted-ELF faults rejected by the intended semantic SAT counterexample: one quotient-bit operation per inline step and one nested-call record source. Original reports and binaries untouched; VM replay of these additional faults remains separate.'}
file=run/'report.json';file.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'mutations':13,'report':str(file)}))
