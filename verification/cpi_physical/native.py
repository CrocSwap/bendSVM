"""Actual emitted CPI caller, observed pending bytes, resize and failure replays.

The instrumented adapter adds observations only. Explicit syscall test doubles
exercise permitted external mutations; they do not establish runtime permissions,
transaction rollback or a universal compiled-program theorem.
"""
import hashlib,json,os,pathlib,subprocess,sys,uuid
assert __debug__
root=pathlib.Path.cwd()
run=pathlib.Path(sys.argv[1])
sys.path.insert(0,str(root/'verification'))
import multi_adapter_contract as m
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
input_path=run/'fixtures/input.json';profile_path=run/'native-profiles.json'
data=json.loads(input_path.read_bytes());profiles=json.loads(profile_path.read_bytes())
inputs=json.loads((run/'inputs.json').read_bytes())['inputs']
inputs.update(data['immutableInputs']);inputs.update(profiles['inputs'])
template_path=root/'tests/cpi-physical-caller-native.c'
for p in [input_path,profile_path,template_path,pathlib.Path(__file__)]:inputs[str(p)]=sha(p)
def bound():
 for p,h in inputs.items():assert sha(p)==h,p
bound()
attempt=run/'native-attempts'/str(uuid.uuid4());attempt.mkdir(parents=True)
template=template_path.read_text();rows=[]
def replace_once(text,old,new):
 assert text.count(old)==1,(old,text.count(old));return text.replace(old,new)
def replay(command,folder,label,timeout):
 result=subprocess.run(command,capture_output=True,text=True,timeout=timeout)
 (folder/(label+'.stdout')).write_text(result.stdout);(folder/(label+'.stderr')).write_text(result.stderr)
 return result
try:
 for fixture in data['fixtures']:
  summary=m.summarize(fixture['schema'],fixture['interface'])
  fields=summary['fields'];assert 2<=len(fields)<=4 and summary['slots']==2
  profile=next(p for p in profiles['rows'] if p['fixture']==fixture['name'])
  assert profile['expectedDataBytes']==[42,99]
  adapter=fixture['files'][fixture['adapter']]
  extraction='if(!bend_extract_effects(&outcome.as.c0.f1,transfers)) return 9;'
  watches='watch_add(reply,sizeof(reply));watch_add(transfers,sizeof(transfers));'
  watches+=''.join(f'watch_add(header{i},sizeof(header{i}));watch_add(encoded{i},sizeof(encoded{i}));' for i in range(len(fields)))
  instrumented=replace_once(adapter,extraction,extraction+'\n'+watches)
  constants=f'#define FIELD_COUNT {len(fields)}\n#define REPLY_SIZE {1+5*len(fields)}\n'
  for name,values in [('index',[f['index'] for f in fields]),('size',[f['stateBytes'] for f in fields]),('binding',[f['bindingBytes'] for f in fields])]:
   constants+=f'static const unsigned field_{name}[FIELD_COUNT]={{'+','.join(map(str,values))+'};\n'
  constants+='static const u8 field_header[FIELD_COUNT][20]={'+','.join('{'+','.join(map(str,f['header']))+'}' for f in fields)+'};\n'
  initialize=''
  for i in range(12):
   field=next((f for f in fields if f['index']==i),None)
   size=field['stateBytes'] if field else 128 if i==11 else 0
   initialize+=f'buffer[offset]=255;buffer[offset+1]=1;buffer[offset+2]=1;buffer[offset+3]={int(i==2)};buffer[offset+8]={i+1};buffer[offset+40]=100;write_le(buffer+offset+72,1000,8);write_le(buffer+offset+80,{size},8);data[{i}]=buffer+offset+88;owner[{i}]=buffer+offset+40;expected_length[{i}]={size};\n'
   if field:
    number=fields.index(field)
    initialize+=f'if(mode){{memcpy(data[{i}],field_header[{number}],20);'
    if field['bindingBytes']:initialize+=f'data[{i}][20]=1;'
    initialize+=f'write_le(data[{i}]+{21+field["bindingBytes"]},prior,4);}}\n'
   initialize+=f'offset=(offset+88+{size}+10240+7)&~7ULL;offset+=8;\n'
  code=replace_once(template,'/* ACTUAL_ADAPTER */',instrumented)
  code=replace_once(code,'/* FIELD_CONSTANTS */',constants)
  code=replace_once(code,'/* INSTRUCTION_BYTES */',','.join(map(str,profile['bytes'])))
  code=replace_once(code,'/* INITIALIZE_ACCOUNTS */',initialize)
  refresh='for(unsigned i=0;i<count;++i) a[i].size=infos[i].data_len;'
  header=fixture['files']['bend_cpi.h'];assert header.count(refresh)==1
  controls=[('baseline',header,0,None),
   ('missing-refresh',replace_once(header,refresh,'/* intentional missing refresh */'),49,'later call stale account length'),
   ('wrong-refresh-account',replace_once(header,refresh,'for(unsigned i=0;i<count;++i) a[i].size=infos[0].data_len;'),49,'later call stale account length'),
   ('pending-poison',replace_once(header,'if(error) return error;','if(error) return error;watch_poison();'),43,'pending bytes changed'),
   ('managed-data-write',replace_once(header,'if(!t->active) return 0;\n  BendAccountInfo','if(!t->active) return 0;\n  a[0].data[0]^=1;\n  BendAccountInfo'),45,'managed bytes changed before commit'),
   ('expose-pending-data',replace_once(header,'a[i].size,a[i].data,a[i].owner','a[i].size,(i==11?(u8*)t->data:a[i].data),a[i].owner'),44,'pending range exposed')]
  fixture_rows=[]
  for name,cpi,expected_exit,expected_message in controls:
   folder=attempt/fixture['name']/name;folder.mkdir(parents=True)
   for filename,content in fixture['files'].items():
    assert pathlib.Path(filename).name==filename
    (folder/filename).write_text(cpi if filename=='bend_cpi.h' else content)
   path=folder/'observed.c';path.write_text(code);exe=folder/'observed.out'
   command=[os.environ.get('CC','clang'),'-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all','-I',str(folder),str(path),'-o',str(exe)]
   compiled=replay(command,folder,'compile',30);assert compiled.returncode==0,compiled.stderr
   executed=replay([str(exe)],folder,'execute',10)
   assert executed.returncode==expected_exit,(fixture['name'],name,executed.returncode,executed.stderr)
   if expected_message:assert executed.stderr.strip()==expected_message,executed.stderr
   else:
    observation=json.loads(executed.stdout);assert observation=={'scenarios':36,'pendingBuffers':2+2*len(fields)},observation
   files={str(p):sha(p) for p in folder.iterdir() if p.is_file()}
   row={'name':name,'expectedExit':expected_exit,'exitCode':executed.returncode,'expectedMessage':expected_message,'files':files,'command':command}
   if name=='baseline':row['scenarios']=36
   fixture_rows.append(row);print(fixture['name'],name,'passed',flush=True)
  rows.append({'fixture':fixture['name'],'pendingBuffers':2+2*len(fields),'observationsOnly':True,'rows':fixture_rows})
 bound()
 report={'passed':True,'sourcePromoted':True,'endToEndVerified':False,'scenarios':108,'semanticControls':15,'inputs':inputs,'rows':rows,'scope':__doc__}
 (attempt/'report.json').write_text(json.dumps(report,indent=2)+'\n')
 (run/'native-report.json').write_text(json.dumps({'report':str(attempt/'report.json'),'sha256':sha(attempt/'report.json')},indent=2)+'\n')
 print(json.dumps({'passed':True,'report':str(attempt/'report.json'),'scenarios':108,'semanticControls':15}))
except BaseException as error:
 (attempt/'failure.json').write_text(json.dumps({'passed':False,'error':repr(error),'inputs':inputs,'rows':rows},indent=2)+'\n')
 raise
