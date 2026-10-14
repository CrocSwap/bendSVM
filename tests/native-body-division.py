"""Actual parsed division bodies, mutated C, and native witness replay."""
from pathlib import Path
import json,sys,subprocess,hashlib,os,uuid
if not __debug__:raise RuntimeError('division controls require assertions')
root=Path.cwd();sys.path.insert(0,str(root/'verification'))
from native_divmod_ast import prove
from acyclic_c import function_bodies
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
receipt_path=Path(os.environ.get('NATIVE_BODY_RECEIPT',str(root/'build/native-body-lowering/fresh-receipt.json')))
receipt=json.loads(receipt_path.read_text());assert receipt['passed']
report_path=Path(receipt['bodyReport']);assert sha(report_path)==receipt['bodyReportSha256'];report=json.loads(report_path.read_text());assert report['passed'] and len(report['rows'])==6
bound={**report['sourceHashes'],str(Path(__file__).resolve()):sha(Path(__file__)),str(root/'verification/native_divmod_ast.py'):sha(root/'verification/native_divmod_ast.py')}
for p,h in bound.items():assert sha(p)==h,p
manifest={'rows':[]}
for row in report['rows']:
 if row['operation']!='divmod':continue
 for p,h in row['artifacts'].items():assert sha(p)==h
 ast_path=next(p for p in row['artifacts'] if p.endswith('.ast.json'));ast=json.loads(Path(ast_path).read_text());symbol=ast['name']
 assert prove(ast,symbol)==row['nativeProof'] and row['nativeProof']['result']=='unsat'
 manifest['rows'].append({**row,'symbol':symbol,'ast':ast_path})
assert [r['fixture'] for r in manifest['rows']]==['examples/vesting/PROOF.bend','examples/exchange/PROOF.bend','examples/amm/PROOF.bend']
base=root/'build/native-body-division-controls'/str(uuid.uuid4());out=base/'mutations';out.mkdir(parents=True)
controls=[
 ('wrong-quotient','q = n / d','q = n * d',(7,2)),
 ('lost-remainder','r = n % d','r = 0',(7,2)),
 ('wrong-numerator-high','a0.as.c0.f1 << 32','a0.as.c0.f1 << 16',((1<<40)+7,2)),
 ('inverted-zero-guard','if (!d)','if (d)',(7,2)),
 ('wrong-error-code','_DivErr_make(3u)','_DivErr_make(0u)',(7,0)),
 ('lost-quotient-high','(bend_u32)(q >> 32)','(bend_u32)0',((1<<63)+7,2)),
 ('reachable-unreachable','a0.tag != 0u','a0.tag == 0u',(7,2)),
]
rows=[]
for item in manifest['rows']:
 label=Path(item['fixture']).parent.name;original=None
 # Header path is recorded explicitly in the compiler input inventory.
 original=next(Path(p) for p in item['artifacts'] if p.endswith('.h'));c=original.read_text();body=function_bodies(c)[item['symbol']]
 for name,before,after,pin in controls:
  assert body.count(before)==1,(name,body.count(before));assert c.count(body)==1
  folder=out/(label+'-'+name);folder.mkdir();header=folder/'mutant.h';header.write_text(c.replace(body,body.replace(before,after)));wrapper=folder/'mutant.c';wrapper.write_text('#include "mutant.h"\n')
  command=item['command'][:-1]+[str(wrapper)];result=subprocess.run(command,capture_output=True,text=True,timeout=30);(folder/'clang.log').write_text(result.stderr);assert result.returncode==0,result.stderr
  astfile=folder/'mutant.ast.json';astfile.write_text(result.stdout);proof=prove(json.loads(result.stdout),item['symbol'],pin);assert proof['result']=='sat',name
  rows.append({'fixture':item['fixture'],'name':name,'pin':pin,'proof':proof,'command':command,'artifacts':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [header,wrapper,astfile,folder/'clang.log']}})


assert len(rows)==21
semantic_rows=rows;byfixture={x['fixture']:x for x in manifest['rows']};rows=[]
cc=os.environ.get('CC','clang');version=subprocess.check_output([cc,'--version'],text=True)
for row in semantic_rows:
 item=byfixture[row['fixture']];symbol=item['symbol'];prefix=symbol[:-6];header=next(Path(p) for p in row['artifacts'] if p.endswith('.h'));folder=header.parent
 n,d=row['pin'];source=folder/'replay.c';binary=folder/'replay'
 source.write_text('#include <stdio.h>\n#include "mutant.h"\nint main(void) {\n'+
 f'  {prefix}DivResult_t r={symbol}({prefix}U64_make({n&0xffffffff}u,{n>>32}u),{prefix}U64_make({d&0xffffffff}u,{d>>32}u));\n'+
 '  if (r.tag==1u) { printf("error %u\\n",r.as.c1.f0); return 0; }\n'+
 '  if (r.tag!=0u) return 2;\n'+
 '  unsigned long long q=((unsigned long long)r.as.c0.f0.as.c0.f0.as.c0.f1<<32)|r.as.c0.f0.as.c0.f0.as.c0.f0;\n'+
 '  unsigned long long rem=((unsigned long long)r.as.c0.f0.as.c0.f1.as.c0.f1<<32)|r.as.c0.f0.as.c0.f1.as.c0.f0;\n'+
 '  printf("ok %llu %llu\\n",q,rem); return 0;\n}\n')
 command=[cc,'-std=c17','-O1','-fsanitize=undefined','-fno-sanitize-recover=all',str(source),'-o',str(binary)]
 result=subprocess.run(command,capture_output=True,text=True,timeout=30);(folder/'replay-build.log').write_text(result.stdout+result.stderr);assert result.returncode==0,result.stderr
 result=subprocess.run([str(binary.resolve())],capture_output=True,text=True,timeout=10);(folder/'replay.log').write_text(result.stdout+result.stderr)
 expected='error 3' if d==0 else f'ok {n//d} {n%d}'
 if row['name']=='reachable-unreachable':assert result.returncode!=0 and 'execution reached an unreachable program point' in result.stderr
 else:assert result.returncode==0 and result.stdout.strip()!=expected,(row['name'],result.stdout,expected)
 rows.append({'fixture':row['fixture'],'name':row['name'],'expected':expected,'actual':result.stdout.strip(),'exitCode':result.returncode,'command':command,'artifacts':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [source,binary,folder/'replay-build.log',folder/'replay.log']}})


# Exercise the parser's refusal boundary and accepted equivalent spellings.
import native_divmod_ast as model
row=manifest['rows'][-1];symbol=row['symbol']
original=next(Path(p).read_text() for p in row['artifacts'] if p.endswith('.h'))
body=function_bodies(original)[symbol];files=[]
def parse(label,before,after):
 assert body.count(before)==1,(label,before)
 header=base/(label+'.h');header.write_text(original.replace(body,body.replace(before,after)))
 cmd=row['command'][:-1]+['-x','c',str(header)];result=subprocess.run(cmd,capture_output=True,text=True,timeout=30);log=base/(label+'.log');log.write_text(result.stderr);assert result.returncode==0,result.stderr
 ast=base/(label+'.ast.json');ast.write_text(result.stdout);files.extend([header,log,ast]);return json.loads(result.stdout)
refusals=[]
for label,before,after,reason in [
 ('signed','unsigned long long q =','long long q =','unsupported scalar type long long'),
 ('overshift','(q >> 32)','(q >> 64)','undefined shift'),
 ('side-effect','unsigned long long r = n % d;','unsigned long long r = n % d; q++;','unsupported statement UnaryOperator'),
 ('missing-width','_Static_assert(sizeof(unsigned long long) == 8, "Requires 64-bit unsigned long long");','','body inventory')]:
 ast=parse(label,before,after)
 try:prove(ast,symbol)
 except ValueError as e:assert str(e)==reason,(label,str(e));refusals.append({'name':label,'reason':reason})
 else:raise AssertionError('grammar accepted')
equivalents=[]
for label,before,after in [('split-shift','(q >> 32)','(q >> 16 >> 16)'),('zero-equality','if (!d)','if (d == 0u)')]:
 result=prove(parse(label,before,after),symbol);assert result['result']=='unsat';equivalents.append({'name':label,'proof':result})
class Unknown:
 def set(self,**kwargs):pass
 def add(self,*args):pass
 def check(self):return model.z.unknown
 def reason_unknown(self):return 'injected UNKNOWN'
saved=model.z.Solver
try:
 model.z.Solver=Unknown
 try:prove(json.loads(Path(row['ast']).read_text()),symbol)
 except ValueError as e:assert str(e)=='UNKNOWN: injected UNKNOWN'
 else:raise AssertionError('UNKNOWN accepted')
finally:model.z.Solver=saved

for p,h in bound.items():assert sha(p)==h,p
output={'passed':True,'grammarRefusals':refusals,'equivalentBodies':equivalents,'unknownRefused':True,'grammarArtifacts':{str(p):sha(p) for p in files},'semanticControls':semantic_rows,'nativeReplays':rows,'sourceHashes':bound,'positiveReceipt':str(receipt_path),'positiveReceiptSha256':sha(receipt_path),'positiveBodyReport':str(report_path),'positiveBodyReportSha256':sha(report_path),'hostCompiler':version,'scope':'Three actual SBF-Clang division bodies with 21 existential C counterexamples replayed natively. Positive proofs unpinned. No SBF machine equivalence theorem.'}
p=base/'report.json';p.write_text(json.dumps(output,indent=2)+'\n');print(json.dumps({'passed':True,'report':str(p),'sha256':sha(p)}))
