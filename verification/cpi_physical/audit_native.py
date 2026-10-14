"""Independent retained-input and semantic replay audit of the CPI native gate."""
import hashlib,json,pathlib,subprocess,sys,uuid
assert __debug__
root=pathlib.Path.cwd()
run=pathlib.Path(sys.argv[1])
reports=list((run/'native-attempts').glob('*/report.json'));assert len(reports)==1
report_path=reports[0];report=json.loads(report_path.read_bytes())
assert report['passed'] is True and report['sourcePromoted'] is True and report['endToEndVerified'] is False
assert report['scenarios']==108 and report['semanticControls']==15
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
bindings=dict(report['inputs']);bindings[str(report_path)]=sha(report_path)
bindings[str(pathlib.Path(__file__).resolve())]=sha(pathlib.Path(__file__))
data=json.loads((run/'fixtures/input.json').read_bytes())
expected={'baseline':(0,None),'missing-refresh':(49,'later call stale account length'),
 'wrong-refresh-account':(49,'later call stale account length'),
 'pending-poison':(43,'pending bytes changed'),
 'managed-data-write':(45,'managed bytes changed before commit'),
 'expose-pending-data':(44,'pending range exposed')}
assert [r['fixture'] for r in report['rows']]==[f['name'] for f in data['fixtures']]==['cpi-2','cpi-3','cpi-4']
replayed=[]
out=run/'native-audits'/str(uuid.uuid4());out.mkdir(parents=True)
for row,fixture in zip(report['rows'],data['fixtures']):
 assert row['observationsOnly'] is True
 assert [r['name'] for r in row['rows']]==list(expected)
 original=fixture['files']['bend_cpi.h'];refresh='for(unsigned i=0;i<count;++i) a[i].size=infos[i].data_len;'
 mutations={'baseline':original,
  'missing-refresh':original.replace(refresh,'/* intentional missing refresh */'),
  'wrong-refresh-account':original.replace(refresh,'for(unsigned i=0;i<count;++i) a[i].size=infos[0].data_len;'),
  'pending-poison':original.replace('if(error) return error;','if(error) return error;watch_poison();'),
  'managed-data-write':original.replace('if(!t->active) return 0;\n  BendAccountInfo','if(!t->active) return 0;\n  a[0].data[0]^=1;\n  BendAccountInfo'),
  'expose-pending-data':original.replace('a[i].size,a[i].data,a[i].owner','a[i].size,(i==11?(u8*)t->data:a[i].data),a[i].owner')}
 pending_count=2+2*int(fixture['name'][-1]);assert row['pendingBuffers']==pending_count
 for control in row['rows']:
  name=control['name'];code,message=expected[name]
  assert (control['expectedExit'],control['exitCode'],control['expectedMessage'])==(code,code,message)
  files=control['files'];bindings.update(files)
  code_path=next(pathlib.Path(p) for p in files if pathlib.Path(p).name=='observed.c')
  folder=code_path.parent
  # The owning emitted files are unchanged, except the single deliberate
  # runtime mutation. Observations appear only in the compiled harness copy.
  for filename,text in fixture['files'].items():
   assert (folder/filename).read_text()==(mutations[name] if filename=='bend_cpi.h' else text)
  baseline=fixture['files'][fixture['adapter']]
  marker='if(!bend_extract_effects(&outcome.as.c0.f1,transfers)) return 9;'
  watches='watch_add(reply,sizeof(reply));watch_add(transfers,sizeof(transfers));'+''.join(f'watch_add(header{i},sizeof(header{i}));watch_add(encoded{i},sizeof(encoded{i}));' for i in range(int(fixture['name'][-1])))
  instrumented=baseline.replace(marker,marker+'\n'+watches)
  assert baseline.count(marker)==1 and code_path.read_text().count(instrumented)==1
  exe=folder/'observed.out';assert str(exe) in files
  args=control['command'];assert args[-1]==str(exe) and args[-3]==str(code_path)
  assert '-fsanitize=address,undefined' in args and '-fno-sanitize-recover=all' in args
  for p,h in bindings.items():assert sha(p)==h,p
  execution=subprocess.run([str(exe)],capture_output=True,text=True,timeout=10)
  assert execution.returncode==code,(row['fixture'],name,execution.returncode,execution.stderr)
  if message:assert execution.stderr.strip()==message
  else:assert json.loads(execution.stdout)=={'scenarios':36,'pendingBuffers':pending_count}
  log=out/(row['fixture']+'-'+name+'.json')
  log.write_text(json.dumps({'exitCode':execution.returncode,'stdout':execution.stdout,'stderr':execution.stderr},indent=2)+'\n')
  replayed.append({'fixture':row['fixture'],'control':name,'exitCode':code,'log':str(log),'logSha256':sha(log)})
for p,h in bindings.items():assert sha(p)==h,p
result={'passed':True,'sourcePromoted':True,'scenarios':108,'compiledSemanticControls':15,
 'bindings':bindings,'replayed':replayed,
 'scope':'Fresh hash audit of actual owning fixture/include closure, exact observations-only adapter copy, canonical distinct payload profile, sanitizers and explicit five runtime faults per fixture; all 18 retained executables rerun. Finite native test doubles, not runtime permission, rollback or machine proof.'}
(out/'report.json').write_text(json.dumps(result,indent=2)+'\n')
(run/'native-audit.json').write_text(json.dumps({'report':str(out/'report.json'),'sha256':sha(out/'report.json')},indent=2)+'\n')
print(json.dumps({'passed':True,'report':str(out/'report.json'),'bindings':len(bindings)}))
