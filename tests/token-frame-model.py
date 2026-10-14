"""Check exact frame coverage, including arbitrary writes at every allowed byte."""
from pathlib import Path
import hashlib,inspect,json,os,sys
out=Path(os.environ.get('TOKEN_FRAME_MODEL_REPORT','build/token-frame-model-test.json'));out.parent.mkdir(parents=True,exist_ok=True);out.unlink(missing_ok=True)
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,os.environ.get('TOKEN_FRAME_MODULES','verification'))
import token_frame as frame
from adapter_contract_c import Grammar
inputs=[Path(__file__).resolve(),Path(frame.__file__),Path(frame.t.__file__),Path(inspect.getfile(Grammar))]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
before={str(p):sha(p) for p in inputs}
z=frame.z;t=frame.t
need=t.need
need(z.get_version_string()=='5.1.0','Z3 pin')
word=z.BitVecSort(32);data=z.Array('frame_test_data',word,z.ArraySort(word,z.BitVecSort(8)));sizes=z.Array('frame_test_sizes',word,z.BitVecSort(64))
account=z.BitVec('frame_test_account',32);offset=z.BitVec('frame_test_offset',32)
# Independent specification: account interval and per-layout half-open spans.
layout={82:[(36,44)],165:[(64,108),(121,129)]}
allowed=z.And(z.UGE(account,4),z.ULT(account,12),z.Or([z.And(z.Select(sizes,account)==size,z.Or([z.And(z.UGE(offset,start),z.ULT(offset,end)) for start,end in spans])) for size,spans in layout.items()]))
replacement=z.Const('model_coverage_replacement',data.sort())
read=lambda a:z.Select(z.Select(a,account),offset)
expected=z.If(allowed,read(replacement),read(data))
def check(fn,wanted):
 after=fn(data,sizes,'model_coverage');s=z.Solver();s.set(timeout=30000);s.add(read(after)!=expected);result=s.check();need(str(result)==wanted,('frame coverage',str(result)));row={'result':str(result)}
 if result==z.sat:
  m=s.model();row['witness']={name:m.eval(value,model_completion=True).as_long() for name,value in [('account',account),('offset',offset),('size',z.Select(sizes,account)),('actual',read(after)),('expected',expected)]}
 return row
positive=check(frame.data_frame,'unsat');source=inspect.getsource(frame.data_frame);faults=[]
for name,old,new in [('narrow-token-span','t.bv(108)','t.bv(107)'),('omit-last-account','t.bv(12)','t.bv(11)'),('allow-decimals-write','t.bv(44)','t.bv(45)')]:
 need(source.count(old)==1,'unique frame mutation');namespace={'z':z,'t':t};exec(compile(source.replace(old,new),'<frame mutation>','exec'),namespace)
 faults.append({'name':name,**check(namespace['data_frame'],'sat')})
controls=[]
for name,args in [('scalar-data',[z.BitVec('bad_data',32),sizes,'bad']),('flat-data',[z.Array('flat',word,z.BitVecSort(8)),sizes,'bad']),('wrong-size-width',[data,z.Array('bad_sizes',word,word),'bad']),('empty-prefix',[data,sizes,''])]:
 try:frame.data_frame(*args)
 except Grammar as error:controls.append({'name':name,'reason':str(error)})
 else:raise RuntimeError('accepted malformed '+name)
need(before=={str(p):sha(p) for p in inputs},'frame model source drift')
report={'passed':True,'endToEndVerified':False,'coverage':positive,'faults':faults,'refusals':controls,'sourceHashes':before,'z3':z.get_version_string(),'scope':'Exact symbolic array frame coverage and source mutations; not runtime enforcement of token write limits.'}
pending=out.with_suffix('.pending');pending.write_text(json.dumps(report,indent=2)+'\n');pending.replace(out);print(json.dumps({'passed':True,'faults':len(faults),'refusals':len(controls),'report':str(out)}))
