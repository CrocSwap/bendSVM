"""Run from native-handler overlay; bind source certificate to SBF Clang AST."""
import argparse,hashlib,importlib.util,json,os,pathlib,subprocess,sys,uuid
if not __debug__:raise RuntimeError('assertions required')
root=pathlib.Path.cwd();base=pathlib.Path(__file__).resolve().parent;sys.path.insert(0,str(root/'verification'))
from native_handler_report import validate
from native_mul32 import certify
from native_divmod import certify as certify_divmod
import native_divmod_ast as division_model
from acyclic_c import mangle
spec=importlib.util.spec_from_file_location('native64',base/'native_c64_ast.py');model=importlib.util.module_from_spec(spec);spec.loader.exec_module(model)
spec_r=importlib.util.spec_from_file_location('native64_report',base/'native_body_report.py');report_model=importlib.util.module_from_spec(spec_r);spec_r.loader.exec_module(report_model)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
parser=argparse.ArgumentParser();parser.add_argument('--receipt',type=pathlib.Path);parser.add_argument('--output-root',type=pathlib.Path);args=parser.parse_args()
focused_path=args.receipt if args.receipt is not None else root/'build/native-handler-test.json';focused=json.loads(focused_path.read_text());receipt=focused if args.receipt is not None else focused['receipt'];need=model.need
need(focused['passed'] is True and receipt['passed'] is True,'source receipt')
input_path=root/receipt['inputArtifact'];raw=input_path.read_bytes();data=json.loads(raw);report_path=root/receipt['reportArtifact'];report=json.loads(report_path.read_text())
need(sha(input_path)==receipt['inputSha256'] and sha(report_path)==receipt['reportSha256'],'input/report binding');validate(report,data,raw)
compiler=pathlib.Path(os.environ.get('SBF_TOOLS',str(pathlib.Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin')))/'clang';version=subprocess.check_output([str(compiler),'--version'],text=True,timeout=30)
need('20.1.7' in version and 'anza-xyz' in version,'compiler pin')
inputs={str(root/p):h for p,h in data['sourceHashes'].items()};inputs.update({str(p):sha(p) for p in [base/'native_c64_ast.py',base/'native_divmod_ast.py',base/'native_divmod.py',base/'native_body_report.py',base/'check-native-body.py',base/'check-native-body.ts',pathlib.Path(__file__).resolve(),focused_path,input_path,report_path,compiler]})
def bound():
 for p,h in inputs.items():need(sha(pathlib.Path(p))==h,'source/artifact drift '+p)
bound();run=(args.output_root if args.output_root is not None else root/'build/native-body-lowering/body-runs')/str(uuid.uuid4());run.mkdir(parents=True);rows=[]
for p in data['programs']:
 for operation,certificate,leaf_model in [
  ('mul32',certify(p,report['prerequisite'],data['sourceModels']['math'].encode()),model),
  ('divmod',certify_divmod(p,report['divisionPrerequisite'],data['sourceModels']['division'].encode()),division_model)]:
  symbol=mangle(certificate['sourceFunction']);label=pathlib.Path(p['source']['source']).parent.name+'-'+operation
  header=run/(label+'.h');header.write_text(p['artifact']['c']);need(sha(header)==p['artifact']['cSha256'],'C bytes')
  wrapper=run/(label+'.c');wrapper.write_text('#include "'+header.name+'"\n')
  command=[str(compiler),'--target=sbf','-mcpu=generic','-ffreestanding','-fno-builtin','-fno-stack-protector','-std=c17','-fsyntax-only','-Xclang','-ast-dump=json','-Xclang','-ast-dump-filter','-Xclang',symbol,str(wrapper)]
  result=subprocess.run(command,capture_output=True,text=True,timeout=30);log=run/(label+'.log');log.write_text(result.stderr);need(result.returncode==0,'frontend failure '+result.stderr)
  ast=run/(label+'.ast.json');ast.write_text(result.stdout);proof=leaf_model.prove(json.loads(result.stdout),symbol);need(proof['result']=='unsat','native body discrepancy')
  rows.append({'fixture':p['source']['source'],'operation':operation,'sourceCertificate':certificate,'nativeProof':proof,'command':command,'artifacts':{str(f):sha(f) for f in [header,wrapper,ast,log]}})
bound();output={'passed':True,'endToEndVerified':False,'sourceHashes':inputs,'frontendVersion':version,'rows':rows,'scope':report_model.SCOPE}
report_model.validate(output,data,report,inputs,version,compiler,run,model,certify,mangle,sha)
(run/'report.json').write_text(json.dumps(output,indent=2)+'\n');print(json.dumps({'passed':True,'report':str(run/'report.json'),'sha256':sha(run/'report.json')}))
