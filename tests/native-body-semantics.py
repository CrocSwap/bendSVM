"""Actual-C mutations, grammar boundaries, and native witness replays."""
import hashlib,importlib.util,json,os,pathlib,subprocess,uuid
if not __debug__:raise RuntimeError('semantic controls require assertions')
root=pathlib.Path.cwd();sources=pathlib.Path(__file__).resolve().parents[1]/'verification';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
spec=importlib.util.spec_from_file_location('native_ast',sources/'native_c64_ast.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
receipt_path=pathlib.Path(os.environ.get('NATIVE_BODY_RECEIPT',str(root/'build/native-body-lowering/fresh-receipt.json')));receipt=json.loads(receipt_path.read_text());assert receipt['passed']
report_path=pathlib.Path(receipt['bodyReport']);assert sha(report_path)==receipt['bodyReportSha256'];report=json.loads(report_path.read_text());assert report['passed']
for p,h in report['sourceHashes'].items():assert sha(pathlib.Path(p))==h,p
row=report['rows'][0]
for p,h in row['artifacts'].items():assert sha(pathlib.Path(p))==h,p
original=next(pathlib.Path(p).read_text() for p in row['artifacts'] if p.endswith('.h'));original_ast=json.loads(next(pathlib.Path(p).read_text() for p in row['artifacts'] if p.endswith('.ast.json')))
name=original_ast['name'];result_type=original_ast['type']['qualType'].split(' (')[0]
run=root/'build/native-body-semantics'/str(uuid.uuid4());run.mkdir(parents=True);files=[];faults=[];refusals=[];equivalents=[];replays=[]
def parse(label,c):
 header=run/(label+'.h');header.write_text(c)
 command=row['command'][:-1]+['-x','c',str(header)]
 r=subprocess.run(command,capture_output=True,text=True,timeout=30);log=run/(label+'.parse.log');log.write_text(r.stderr);assert r.returncode==0,r.stderr
 ast=run/(label+'.ast.json');ast.write_text(r.stdout);files.extend([header,log,ast]);return header,json.loads(r.stdout)
header,ast=parse('baseline',original);assert m.prove(ast,name)=={'result':'unsat'}
for label,c,pin in [('add',original.replace('(unsigned long long)a0 * (unsigned long long)a1','(unsigned long long)a0 + (unsigned long long)a1'),(3,5)),('shift',original.replace('(product >> 32)','(product >> 31)'),(65536,65536)),('narrow-product',original.replace('(unsigned long long)a0 * (unsigned long long)a1','a0 * a1'),(65536,65536))]:
 assert c!=original;fault_header,fault_ast=parse(label,c);proof=m.prove(fault_ast,name,pin);assert proof['result']=='sat';faults.append({'name':label,**proof});w=proof['witness']
 for image,h,wanted,predicted in [('baseline',header,0,w['expected']),(label,fault_header,42,w['actual'])]:
  file=run/(label+'-'+image+'.c');binary=file.with_suffix('.out')
  file.write_text(f'#include "{h.name}"\nint main(void) {{ {result_type} r={name}({w["a"]}u,{w["b"]}u); unsigned long long actual=((unsigned long long)r.as.c0.f1<<32)|r.as.c0.f0; if(r.tag!=0 || actual!={predicted}ull)return 43; return actual=={w["expected"]}ull?0:42; }}\n')
  command=[os.environ.get('CC','clang'),'-std=c17','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all',str(file),'-o',str(binary)]
  r=subprocess.run(command,capture_output=True,text=True,timeout=30);log=file.with_suffix('.compile.log');log.write_text(r.stdout+r.stderr);assert r.returncode==0,r.stderr
  r=subprocess.run([str(binary)],capture_output=True,text=True,timeout=10);runlog=file.with_suffix('.run.log');runlog.write_text(r.stdout+r.stderr);assert r.returncode==wanted and not r.stderr,(label,r.returncode,r.stderr)
  files.extend([file,binary,log,runlog]);replays.append({'mutation':label,'image':image,'exitCode':r.returncode,'actual':predicted,'compileCommand':command})
for label,c,reason in [('signed',original.replace('unsigned long long','long long').replace('sizeof(long long)','sizeof(unsigned long long)'),'unsupported scalar type long long'),('overshift',original.replace('(product >> 32)','(product >> 64)'),'undefined shift'),('side-effect',original.replace('unsigned long long product = (unsigned long long)a0 * (unsigned long long)a1;', 'unsigned long long product = (unsigned long long)a0 * (unsigned long long)a1;\n product++;'),'expected ReturnStmt'),('missing-width',original.replace('_Static_assert(sizeof(unsigned long long) == 8, "Requires 64-bit unsigned long long");',''),'body inventory')]:
 assert c!=original;_,ast=parse(label,c)
 try:m.prove(ast,name)
 except ValueError as e:assert str(e)==reason,(label,str(e));refusals.append({'name':label,'reason':reason})
 else:raise AssertionError('accepted '+label)
for label,c in [('commuted',original.replace('(unsigned long long)a0 * (unsigned long long)a1','(unsigned long long)a1 * (unsigned long long)a0')),('split-shift',original.replace('(product >> 32)','(product >> 16 >> 16)'))]:
 assert c!=original;_,ast=parse(label,c);proof=m.prove(ast,name);assert proof=={'result':'unsat'};equivalents.append({'name':label,**proof})
class Unknown:
 def set(self,**kwargs):pass
 def add(self,*args):pass
 def check(self):return m.z.unknown
 def reason_unknown(self):return 'injected UNKNOWN'
saved=m.z.Solver
try:
 m.z.Solver=Unknown
 try:m.prove(original_ast,name)
 except ValueError as e:assert str(e)=='UNKNOWN: injected UNKNOWN'
 else:raise AssertionError('UNKNOWN accepted')
finally:m.z.Solver=saved
for p,h in report['sourceHashes'].items():assert sha(pathlib.Path(p))==h,p
out={'passed':True,'integrated':False,'positiveReceipt':str(receipt_path),'positiveReceiptSha256':sha(receipt_path),'positiveBodyReport':str(report_path),'positiveBodyReportSha256':sha(report_path),'sourceHashes':{str(p):sha(p) for p in [sources/'native_c64_ast.py',pathlib.Path(__file__).resolve()]},'faults':faults,'refusals':refusals,'equivalents':equivalents,'unknownRefused':True,'nativeReplays':replays,'artifacts':{str(p):sha(p) for p in files}}
p=run/'report.json';p.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'passed':True,'report':str(p),'sha256':sha(p)}))
