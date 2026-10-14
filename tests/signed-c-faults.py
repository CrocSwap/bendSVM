from pathlib import Path
import copy,hashlib,json,sys,os
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
from modular_c import check
from acyclic_c import mangle
input_file=Path(os.environ['SIGNED_INPUT']);root=input_file.parent;raw=input_file.read_bytes();data=json.loads(raw);sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest();rows=[]
for p,h in data['sourceHashes'].items():assert sha(p)==h,p
original=data['program']['artifact']['c']
for name,fn,old,new in [('lost-sign','extend32','4294967295u','0u'),('lost-byte-mask','byte_bits','255u','4294967295u'),('wrong-product-operand','mul8','bend_byte_5f_bits(a1)','bend_byte_5f_bits(a0)'),('wrong-word','add32_wrap','(a0).as.c0.f0','(a0).as.c0.f1')]:
 start=original.index(' '+mangle(fn)+'(');start=original.rfind('static ',0,start);end=original.index('\n}',start)+2;part=original[start:end];assert part.count(old)==1
 p=copy.deepcopy(data['program']);p['artifact']['c']=original[:start]+part.replace(old,new)+original[end:];p['artifact']['cSha256']=hashlib.sha256(p['artifact']['c'].encode()).hexdigest();result=check(p)
 assert result['passed'] is False and result['claims'][-1]['function']==fn and result['claims'][-1]['result']=='sat'
 rows.append({'name':name,'cSha256':p['artifact']['cSha256'],'counterexample':result['claims'][-1]})
for p,h in data['sourceHashes'].items():assert sha(p)==h,p
(root/'c-faults.json').write_text(json.dumps({'passed':True,'inputSha256':hashlib.sha256(raw).hexdigest(),'checkerSha256':sha(Path(__file__)),'faults':rows},indent=2)+'\n');print('Four signed SDK C faults detected')
