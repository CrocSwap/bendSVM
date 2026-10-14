"""CPI generated-C extraction sensitivity controls; no adapter composition claim."""
from pathlib import Path
import sys,json,runpy,copy,hashlib
sys.path.insert(0,'verification')
from acyclic_c import Source
from adapter_contract_c import Grammar
if not __debug__:raise RuntimeError('assertions required')
input_path=Path(sys.argv[1]);root=Path(sys.argv[2]);root.mkdir(parents=True,exist_ok=True);payload=json.loads(input_path.read_text());api=runpy.run_path('verification/effect_semantics.py');rows=[]
cases=[
 ('count-from-length','out->count=value->as.c1.f4','out->count=value->as.c1.f2'),
 ('length-from-program','out->length=value->as.c1.f2','out->length=value->as.c1.f0'),
 ('program-key-word','out->program_key+0,value->as.c1.f1.as.c0.f0','out->program_key+0,value->as.c1.f1.as.c0.f1'),
 ('last-data-word','out->data+60,value->as.c1.f3.as.c0.f15','out->data+60,value->as.c1.f3.as.c0.f14'),
 ('meta-index','out->metas[0].index=value->as.c1.f5.as.c0.f0.as.c0.f0','out->metas[0].index=value->as.c1.f5.as.c0.f1.as.c0.f0'),
 ('meta-writable','out->metas[0].writable=value->as.c1.f5.as.c0.f0.as.c0.f2','out->metas[0].writable=value->as.c1.f5.as.c0.f0.as.c0.f3'),
 ('last-meta-key-word','out->metas[7].key+28,value->as.c1.f5.as.c0.f7.as.c0.f1.as.c0.f7','out->metas[7].key+28,value->as.c1.f5.as.c0.f7.as.c0.f1.as.c0.f6'),
 ('second-slot-from-first','bend_extract_effect(&value->as.c0.f1,&out[1])','bend_extract_effect(&value->as.c0.f0,&out[1])')]
for f in payload['fixtures']:
 source=Source(f['program']['source']);base={**f,'interface':{**f['interface'],'version':1}};api['Extraction'](source,base).verify()
 for name,old,new in cases:
  changed=copy.deepcopy(base);text=changed['files'][f['adapter']];assert text.count(old)==1,(f['name'],name)
  changed['files'][f['adapter']]=text.replace(old,new)
  try:api['Extraction'](source,changed).verify()
  except (Grammar,ValueError) as error:
   reason=str(error);assert 'effect extraction:' in reason,(name,reason)
   row={'fixture':f['name'],'case':name,'result':'refused','reason':reason};rows.append(row)
   dest=root/'extraction-controls'/f['name'];dest.mkdir(parents=True,exist_ok=True);(dest/(name+'.c')).write_text(changed['files'][f['adapter']])
  else:raise AssertionError('accepted '+f['name']+' '+name)
 print(f['name'],len(cases),'mutations refused',flush=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
inputs=[Path(__file__),Path('verification/effect_semantics.py'),Path('verification/effect_extraction.py'),input_path,*sorted((root/'extraction-controls').rglob('*.c'))]
report={'passed':True,'controls':rows,'inputs':{str(p.resolve()):sha(p) for p in inputs},'scope':__doc__+' The restricted extraction checker rejects incorrect field/slot mappings; these are not executed native or SBF counterexamples.'}
(root/'extraction-controls.json').write_text(json.dumps(report,indent=2)+'\n');print(root/'extraction-controls.json')
