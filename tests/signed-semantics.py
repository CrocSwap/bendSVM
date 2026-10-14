"""Mutations of exported signed SDK source must fail their exact semantic claim."""
from pathlib import Path
import contextlib,copy,hashlib,io,json,os,sys
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
from signed_semantics import check
input_file=Path(os.environ['SIGNED_INPUT']);raw=input_file.read_bytes();data=json.loads(raw)
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
for p,h in data['sourceHashes'].items():assert sha(p)==h,p
positive=check(data['program']);rows=[]
for name,fn,old,new,claim in [
 ('lost-sign','extend32',{'$':'U32','value':4294967295},{'$':'U32','value':0},'all-u32-sign-extension'),
 ('lost-mask','byte_bits',{'$':'U32','value':255},{'$':'U32','value':4294967295},'all-u32-low-byte-decode'),
 ('add-instead-of-product','mul8',{'$':'Ref','k':'U32.mul'},{'$':'Ref','k':'U32.add'},'all-u32-low-byte-product'),
 ('high-word-addition','add32_wrap',{'$':'Var','i':0},{'$':'Var','i':1},'all-u64-narrow-wrapping-add'),
]:
 p=copy.deepcopy(data['program']);hits=[]
 def replace(value):
  if value==old:hits.append(1);return copy.deepcopy(new)
  if isinstance(value,dict):return {k:replace(v) for k,v in value.items()}
  if isinstance(value,list):return [replace(v) for v in value]
  return value
 p['source']['functions'][fn]['body']=replace(p['source']['functions'][fn]['body']);assert len(hits)==1
 text=io.StringIO()
 try:
  with contextlib.redirect_stdout(text):check(p)
 except AssertionError:
  assert text.getvalue().splitlines()[-1]==claim+' sat',text.getvalue()
 else:raise AssertionError('accepted '+name)
 rows.append({'name':name,'claim':claim,'result':'sat'})
for p,h in data['sourceHashes'].items():assert sha(p)==h,p
assert input_file.read_bytes()==raw
output=Path(os.environ.get('SIGNED_SEMANTICS_REPORT','build/signed-semantics-test.json'));output.write_text(json.dumps({'passed':True,'inputSha256':sha(input_file),'checkerSha256':sha(Path(__file__)),'positive':positive,'mutations':rows},indent=2)+'\n')
print('Four signed source mutations detected')
