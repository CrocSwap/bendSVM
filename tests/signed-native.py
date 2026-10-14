"""Independent integer oracle and four actual emitted-C mutation replays."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,sys,uuid
base=Path('build/signed-native');run=base/'runs'/str(uuid.uuid4());run.mkdir(parents=True)
latest=base/'fresh-receipt.json'
if latest.exists():latest.rename(run/'previous.json')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main():
 if not __debug__:raise RuntimeError('assertions required')
 input_file=Path(os.environ['SIGNED_INPUT']);raw=input_file.read_bytes();data=json.loads(raw);program=data['program']
 assert program['source']['source']=='sdk/signed.bend' and program['source']['roots']==['extend32','byte_bits','mul8','add32_wrap']
 assert program['defaultProductionCMatches'] is True and hashlib.sha256(program['artifact']['c'].encode()).hexdigest()==program['artifact']['cSha256']
 for p,h in data['sourceHashes'].items():assert sha(p)==h,p
 template=Path(__file__).with_suffix('.c');own={str(p):sha(p) for p in [Path(__file__),template]}
 cc=shutil.which(os.environ.get('CC','clang'));assert cc,'compiler missing';cc_hash=sha(cc)
 version=subprocess.run([cc,'--version'],capture_output=True,text=True,timeout=10);assert version.returncode==0 and version.stdout.strip()
 original=program['artifact']['c'];variants=[('baseline',original,None)]
 for name,fn,old,new,reason in [('lost-sign','bend_extend32','4294967295u','0u','extension'),('lost-byte-mask','bend_byte_5f_bits','255u','4294967295u','decode'),('wrong-product-operand','bend_mul8','bend_byte_5f_bits(a1)','bend_byte_5f_bits(a0)','product'),('wrong-word','bend_add32_5f_wrap','(a0).as.c0.f0','(a0).as.c0.f1','addition')]:
  start=original.index(' '+fn+'(');start=original.rfind('static ',0,start);end=original.index('\n}',start)+2;part=original[start:end];assert part.count(old)==1
  variants.append((name,original[:start]+part.replace(old,new)+original[end:],reason))
 rows=[]
 for name,c,reason in variants:
  folder=run/name;folder.mkdir();(folder/'signed.h').write_text(c);(folder/'native.c').write_bytes(template.read_bytes())
  args=[cc,'-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all',str(folder/'native.c'),'-o',str(folder/'native')]
  result=subprocess.run(args,capture_output=True,text=True,timeout=60);(folder/'compile.log').write_text(result.stdout+result.stderr);assert result.returncode==0,result.stderr
  result=subprocess.run([str(folder/'native')],capture_output=True,text=True,timeout=30);(folder/'run.log').write_text(result.stdout+result.stderr)
  assert result.returncode==(42 if reason else 0),(name,result.stderr)
  if reason:assert result.stderr==reason+'\n',result.stderr
  else:
   assert not result.stderr;counts=json.loads(result.stdout);assert counts=={'extensions':4104,'decodes':1024,'products':262144,'additions':4352}
  rows.append({'name':name,'exitCode':result.returncode,'cSha256':hashlib.sha256(c.encode()).hexdigest(),'artifacts':{str(p):sha(p) for p in folder.iterdir() if p.is_file()}})
 assert input_file.read_bytes()==raw and sha(cc)==cc_hash
 for p,h in {**data['sourceHashes'],**own}.items():assert sha(p)==h,p
 report={'passed':True,'endToEndVerified':False,'input':str(input_file),'inputSha256':sha(input_file),'sourceHashes':data['sourceHashes'],'checkerHashes':own,'compiler':{'path':cc,'sha256':cc_hash,'version':version.stdout},'counts':counts,'replays':rows,'scope':'Sanitized native emitted-C tests against independent signed integer arithmetic, including all low-byte pairs and nonzero high bits; no SBF theorem.'}
 out=run/'report.json';out.write_text(json.dumps(report,indent=2)+'\n');pending=run/'publish.json';pending.write_bytes(out.read_bytes());pending.replace(latest);print('271624 signed arithmetic comparisons and four native faults passed')
try:main()
except BaseException as error:
 (run/'failure.json').write_text(json.dumps({'passed':False,'error':str(error)},indent=2)+'\n');raise
