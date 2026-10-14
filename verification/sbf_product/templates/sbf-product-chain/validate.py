import os
"""Bounded experimental report validator; does not independently prove semantics."""
from pathlib import Path
import hashlib,json,re
if not __debug__:raise RuntimeError('assertions required')
base=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def need(ok,why):
 if not ok:raise ValueError(why)
PATH={'result':'unsat','coneInstructions':153,'mergedNodes':17,'inputs':29,'properties':6,'reachability':'sat'}
PREFIX={'result':'unsat','instructions':29,'writes':[-336,-224,-168]}
CARRY={'result':'unsat','instructions':49,'conditionalSkips':6,'writes':[-384,-376,-368,-328,-264,-168]}
CONTROL_NAMES=['call in operand cone','signed branch','cycle in operand cone','uninitialized stack input','misaligned input word','out-of-range register','shift by width','reserved immediate','input load from stack','write frame pointer','register branch reserved immediate','immediate branch reserved source','coincident conditional successors','solver UNKNOWN','optimized Python']
CONTROL_REASONS=['unsupported path opcode 0x85','unsupported branch','cyclic cone','initialized stack load','input word alignment','register range','shift fields','move fields','input load region','word load base','branch reserved fields','branch reserved fields','coincident branch successors unsupported','UNKNOWN: forced path control','assertions required']
CLAIM_NAMES=['128-bit distributive expansion','p00 exact widening','p10 exact widening','p01 exact widening','p11 exact widening','a packed input','b packed input','universal carry sum reassociation','omitted-low-product control']
def bound_files(values):
 need(type(values) is dict and bool(values),'file inventory')
 for p,h in values.items():
  need(type(p) is str and type(h) is str and re.fullmatch('[0-9a-f]{64}',h) is not None,'hash syntax')
  need(Path(p).is_file() and sha(p)==h,'file hash: '+p)
def fault(d):
 need(type(d) is dict and d.get('result')=='sat','fault result')
 need(bool(d.get('witness',d.get('limbs',{}))),'fault witness')
def validate_report(run,relative,d,schema=None):
 run=Path(run);schema=schema or json.loads((base/'report-schema.json').read_text());spec=schema[relative]
 need(type(d) is dict and sorted(d)==spec['fields'],'report fields')
 need(d['passed'] is True and d['exploratory'] is True,'report status')
 if 'endToEndVerified' in d:need(d['endToEndVerified'] is False,'scope overclaim')
 need(d['scope']==spec['scope'],'scope text')
 need(type(d['inputHashes']) is dict,'input inventory type')
 tools=Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin')))
 actual=sorted(k.replace(str(run)+'/', '$RUN/').replace(str(tools)+'/', '$TOOLS/') for k in d['inputHashes'])
 need(actual==spec['inputPaths'],'input inventory')
 bound_files(d['inputHashes'])
 name=relative.split('/')[-1];folder=relative.split('/')[-2]
 if name=='artifact-report.json':
  need(d['source']=='examples/vesting/PROOF.bend' and d['root']=='vesting.process','artifact source identity')
  need(d['recordedInputDrift'] in [[],['package.json']],'artifact source drift')
  need(d['byteIdentical'] is True and d['elfSha256']==sha(run/'build/sbf-slice-probe/vesting.so'),'artifact rebuild identity')
  need('20.1.7' in d['compilerVersion'] and 'anza-xyz' in d['compilerVersion'],'artifact compiler pin');bound_files(d['outputHashes'])
  fresh=d['freshSourceBuild']
  need(set(fresh)=={'passed','command','exitCode','bendCommit','bunVersion','matchedArtifacts','outputHashes'},'fresh fields')
  need(fresh['passed'] is True and type(fresh['exitCode']) is int and fresh['exitCode']==0,'fresh build status')
  need(fresh['bendCommit']=='7561656155a4285c1e4ccfcb3505ab59524de973' and fresh['bunVersion']=='1.4.2','fresh pins')
  need(len(fresh['command'])==5 and fresh['command'][1:]==['scripts/program.ts','examples/vesting/PROOF.bend','vesting.process','build/vesting'],'fresh command')
  expected={suffix:sha(run/('build/vesting'+suffix)) for suffix in ['.h','.c','.wire.h','.dispatch.h','.so']}
  need(fresh['matchedArtifacts']==expected,'fresh artifact identity')
  target=run/'build/sbf-product-chain/fresh-build';mf=target/'build/vesting.manifest.json'
  fm=json.loads(mf.read_text());original=json.loads((run/'build/vesting.manifest.json').read_text())
  dependency=Path(fresh['command'][0]).parents[2]/'.deps/bend/bend2/base.bend'
  normalized={('.deps/bend/bend2/base.bend' if (target/r).resolve()==dependency.resolve() else r):h for r,h in fm['inputs'].items()}
  need(len(normalized)==len(fm['inputs']) and set(normalized)==set(original['inputs']),'fresh input closure')
  need(fm['source']==original['source'] and fm['root']==original['root'] and fm['bendCommit']==fresh['bendCommit'],'fresh manifest identity')
  for relative,h in fm['inputs'].items():need(sha(target/relative)==h,'fresh source binding')
  for relative,h in normalized.items():need(sha(run/relative)==h,'fresh snapshot binding')
  receipt=fm['sbfCallDepth'];rp=target/receipt['report']['path']
  need(receipt['status']=='accepted' and sha(rp)==receipt['report']['sha256'],'fresh receipt')
  files=[mf,target/'build.log',rp]+[target/('build/vesting'+suffix) for suffix in fm['artifacts']]+[target/r for r in fm['inputs']]
  need(set(fresh['outputHashes'])=={str(p) for p in files},'fresh file inventory');bound_files(fresh['outputHashes'])
  for suffix,h in fm['artifacts'].items():need(sha(target/('build/vesting'+suffix))==h,'fresh manifest artifacts')
  for suffix,h in expected.items():need(sha(target/('build/vesting'+suffix))==h,'fresh compiled artifact')
 elif name=='layout-report.json':
  need(d['wrongOffsetRefused'] is True,'layout negative')
  expected=[('totalLow',84),('totalHigh',88),('startLow',96),('startHigh',100),('endLow',108),('endHigh',112),('nowLow',48),('nowHigh',52)]
  need([(r['name'],r['offset']) for r in d['fields']]==expected,'layout fields');bound_files(d['evidenceHashes'])
 elif name=='paths-report.json':
  need(d['entry']==0x1438 and d['stop']==0x1f38,'path range');need(d['baseline']==PATH,'path claims');fault(d['wrongTotalLimb']);need(d['wrongTotalLimb']['reachability']=='sat','mutant reachability')
 elif name=='controls-report.json':
  need(d['positiveRecovery']==PATH,'positive recovery');need([x['name'] for x in d['controls']]==CONTROL_NAMES,'control inventory')
  need([x['reason'] for x in d['controls']]==CONTROL_REASONS,'control reason');need(type(d['controls'][-1]['exitCode']) is int and d['controls'][-1]['exitCode']!=0,'optimized refusal')
 elif name=='composition-report.json':
  need(d['range']==[0x1f38,0x21a8] and d['cutpoint']==0x2020 and d['instructions']==78,'composition range')
  need(d['freshPrefix']==PREFIX and d['freshSuffix']==CARRY and d['boundary']=={'result':'unsat'},'composition prerequisites')
  need(d['matchedRegisters']==11 and d['matchedRequiredStackSlots']==[-336,-264,-224,-216,-168] and d['extraStackFrameSlots']==[-184,-192,-392],'composition frame');fault(d['boundaryFault'])
 elif name=='product-report.json':
  need([r['name'] for r in d['claims']]==CLAIM_NAMES,'arithmetic claim inventory')
  need([r['result'] for r in d['claims']]==['unsat']*8+['sat'],'arithmetic results');fault(d['claims'][-1])
  need(sha(run/'build/sbf-carry-probe/composition-report.json')==d['compositionSha256'],'composition binding')
  need(sha(run/'build/sbf-carry-probe/product-prerequisite.log')==d['prerequisiteLogSha256'],'composition log binding')
 elif name=='linked-product-report.json':
  need(d['freshPath']==PATH and d['freshPrefix']==PREFIX,'linked prerequisites')
  need(d['boundary']=={'result':'unsat','registers':11,'stackSlots':[-264,-216,-192,-184],'carryExtraStackSlots':[-0xd8,-0x108]},'linked boundary');fault(d['boundaryFault'])
  need(sha(run/'build/sbf-carry-probe/product-report.json')==d['productReportSha256'],'product binding')
  need(sha(run/'build/sbf-operand-probe/product-prerequisite.log')==d['productPrerequisiteLogSha256'],'product log binding')
 elif folder=='sbf-product-tail':
  need(d['range']==[0x21a8,0x2248] and d['instructions']==20,'tail range');need(d['freshPath']==PATH and d['freshCarry']==CARRY,'tail prerequisites')
  need(d['extraStackBoundary']=={'result':'unsat'} and d['tail']=={'result':'unsat'},'tail results')
  need([r['name'] for r in d['faults']]==['subtract-upper-carry','inverted-denominator-test'],'tail fault inventory')
  for r in d['faults']:fault(r)
 elif name=='replay-report.json':
  need(d['baselineCases']==68 and d['executions']==78 and len(d['rows'])==78,'runtime inventory')
  need(set(d['artifacts'])=={'baseline','wrong-total-limb','subtract-high-product','inverted-denominator'},'runtime variants')
  for name,a in d['artifacts'].items():
   need(a['unchangedConeInstructions']==(251 if name=='baseline' else 250),'runtime coverage');bound_files(a['files'])
  expected=[('baseline',True)]*68+[('counterexample',True),('counterexample',False),('counterexample',True)]+[('tail-fault',True),('tail-fault',False),('tail-fault',True),('tail-fault',False)]+[('outside-cone',False)]*3
  need([(r['kind'],r['result']['ok']) for r in d['rows']]==expected,'runtime outcomes')
  need(all(type(r['result']['ok']) is bool and (r['result']['ok'] or r['result'].get('code')==42) for r in d['rows']),'runtime refusal codes')
 else:raise ValueError('unknown report')
 return True

def validate_run(run):
 run=Path(run);schema=json.loads((base/'report-schema.json').read_text())
 need(sorted(str(p.relative_to(run)) for p in run.rglob('*report.json'))==sorted(schema),'report closure')
 snapshot=json.loads((run/'snapshot.json').read_text())
 for relative,h in snapshot['sourceHashes'].items():need(sha(run/relative)==h,'snapshot source')
 bound_files(snapshot['externalHashes'])
 for relative in schema:validate_report(run,relative,json.loads((run/relative).read_text()),schema)
 return {'passed':True,'reports':len(schema),'validatorSha256':sha(Path(__file__)),'schemaSha256':sha(base/'report-schema.json')}
if __name__=='__main__':
 import sys
 print(json.dumps(validate_run(sys.argv[1])))
