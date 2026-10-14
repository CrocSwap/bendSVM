"""Connection controls using strictly validated handler phase reports."""
from pathlib import Path
import copy,json,os,sys
if not __debug__:raise RuntimeError('assertions required')
repo=Path(__file__).resolve().parents[1];sys.path.insert(0,str(repo/'verification'));sys.path.insert(0,str(repo/'verification/sbf_handler'))
import validate as handler
from sbf_zero_fill_connection import connect,EXPECTED
from sbf_zero_fill_report import sha
pointer=json.loads(Path(sys.argv[1]).read_text());main=Path(pointer['runRoot'])/'report.json';assert sha(main)==pointer['reportSha256'];top=json.loads(main.read_text())
ctx=handler.context(top['quotientReport'],Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin'))))
reports={}
for p,h in top['reports'].items():
 assert sha(p)==h
 d=json.loads(Path(p).read_text());handler.validate(d,Path(p),ctx)
 if Path(p).name in set(EXPECTED)|{'memset-wrapper-report.json'}:reports[Path(p).name]=d
proof=json.loads(Path(top['zeroFillReport']).read_text());assert sha(top['zeroFillReport'])==top['zeroFillReportSha256']
connection=connect(proof,reports);assert sha(top['zeroFillConnection'])==top['zeroFillConnectionSha256']
assert json.loads(Path(top['zeroFillConnection']).read_text())==connection
refusals=[]
def refuse(name,change):
 bad=copy.deepcopy(reports);change(bad)
 try:connect(proof,bad)
 except ValueError as e:refusals.append({'name':name,'reason':str(e)})
 else:raise RuntimeError('accepted '+name)
refuse('missing-wrapper',lambda d:d.pop('memset-wrapper-report.json'))
for name in EXPECTED:
 def calls(d,n=name):return d[n]['calls'] if 'calls' in d[n] else d[n]['cases'][0]['calls']
 refuse(name+'-omitted-call',lambda d:calls(d).pop())
 refuse(name+'-wrong-target',lambda d:calls(d)[0].update(target=0))
 refuse(name+'-shifted-interval',lambda d:calls(d)[0].update(offset=calls(d)[0]['offset']+1))
 refuse(name+'-different-image',lambda d,n=name:d[n]['inputHashes'].update({next(p for p in d[n]['inputHashes'] if p.endswith('/vesting.so')):'0'*64}))
assert len(refusals)==13
print(json.dumps({'passed':True,'refusals':refusals,'callInstances':4,'inputs':{str(Path(__file__)):sha(__file__),str(repo/'verification/sbf_zero_fill_connection.py'):sha(repo/'verification/sbf_zero_fill_connection.py')}}))
