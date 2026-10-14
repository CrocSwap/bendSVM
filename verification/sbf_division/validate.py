"""Strict inventories for the emitted div4 qualification reports."""
from pathlib import Path
import hashlib,json
if not __debug__:raise RuntimeError('assertions required')
SCHEMA=json.loads(Path(__file__).with_name('report-schema.json').read_text())
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def need(ok,message):
 if not ok:raise ValueError(message)
def bindings(values,expected):
 need(type(values) is dict and set(values)==set(map(str,expected)),'binding inventory')
 for p,h in values.items():need(type(h) is str and sha(p)==h,'binding drift')
def proof(data,name,stage):
 spec=SCHEMA[name]
 need(type(data) is dict and sorted(data)==spec['keys'],'proof field inventory')
 need(data['passed'] is True and data['endToEndVerified'] is False and data['exploratory'] is True,'proof status')
 need(type(data['scope']) is str and bool(data['scope']),'proof scope')
 claims=data['claims'];need(type(claims) is list and len(claims)==len(spec['claims']),'claim inventory')
 for claim,label in zip(claims,spec['claims']):need(claim=={'name':label,'result':'unsat'},'claim result or identity')
 for key in ['entry','stop','instructions','steps','interfaces','modeledInstructions']:
  if key in spec:need(data[key]==spec[key],'proof structure '+key)
 bindings(data['inputHashes'],[stage/p for p in spec['inputs']])
def composition(data,scout):
 stage=scout.parents[1];proof(data,'div4-composition-report.json',stage)
 fault=data['boundaryFault']
 need(type(fault) is dict and set(fault)=={'name','result','witness'} and fault['name']=='changed divisor high-bit at interface' and fault['result']=='sat' and type(fault['witness']) is str and bool(fault['witness']),'boundary fault')
 files=[scout/n for n in SCHEMA if n!='div4-composition-report.json']
 bindings(data['prerequisites'],files)
 for p in files:proof(json.loads(p.read_text()),p.name,stage)
 need(data['logSha256']==sha(scout/'div4-composition-prerequisites.log'),'composition log')
def replay(data,run,stage,tools):
 need(type(data) is dict and set(data)=={'passed','exploratory','endToEndVerified','inputHashes','artifacts','baselineCases','executions','rows','scope'},'replay fields')
 need(data['passed'] is True and data['endToEndVerified'] is False and data['exploratory'] is True,'replay status')
 need(type(data['scope']) is str and bool(data['scope']),'replay scope')
 need(type(data['baselineCases']) is int and data['baselineCases']==70 and type(data['executions']) is int and data['executions']==73,'replay counts')
 rows=data['rows'];kinds=['baseline']*70+['mutant-spec','mutant-model','wrong-expected']
 need(type(rows) is list and len(rows)==len(kinds),'replay rows')
 seen=set()
 for row,kind in zip(rows,kinds):
  need(type(row) is dict and row.get('kind')==kind,'replay kind')
  need(set(row)==({'kind','result'} if kind=='wrong-expected' else {'kind','result','input'}),'replay row fields')
  result=row['result'];want=kind in ['baseline','mutant-model'];need(type(result) is dict and result.get('ok') is want,'replay outcome')
  need(type(result.get('logs')) is list and bool(result['logs']),'replay logs')
  if not want:need(type(result.get('code')) is int and result['code']==42,'replay refusal')
  if kind!='wrong-expected':
   args=row['input'];need(type(args) is list and len(args)==3 and all(type(v) is int and 0<=v<2**64 for v in args),'replay input')
   if kind=='baseline':need(tuple(args) not in seen,'duplicate baseline');seen.add(tuple(args))
   else:need(args==[2**64-1,0,1],'mutant input')
 files=[stage/'build/sbf-division-scout/replay-div4.py',stage/'build/sbf-slice-probe/vesting.so',stage/'build/vesting.h',stage/'verification/sbf_elf.py',tools/'clang',tools/'ld.lld',stage/'target/debug/bend-test-runner',stage/'runtime/sbf.ld',run/'layout.c',run/'layout.log']
 bindings(data['inputHashes'],files)
 need(type(data['artifacts']) is dict and set(data['artifacts'])=={'baseline','clear-last-quotient-bit'},'replay artifacts')
 for name,a in data['artifacts'].items():
  need(type(a) is dict and set(a)=={'bodyOffset','bodyBytes','bodySha256','files'} and a['bodyOffset']==328 and a['bodyBytes']==1864,'replay body structure')
  bindings(a['files'],[run/(name+suffix) for suffix in ['.s','.o','.so','.log']])
  # Hash the actual assembled body, not only its containing artifact.
  import sys
  sys.path.insert(0,str(stage/'verification'))
  from sbf_elf import text_section
  _,text=text_section((run/(name+'.so')).read_bytes())
  need(len(text)==328+1864 and hashlib.sha256(text[328:]).hexdigest()==a['bodySha256'],'replay body hash')

  source_address,source_text=text_section((stage/'build/sbf-slice-probe/vesting.so').read_bytes())
  expected=bytearray(source_text[0x5c50-source_address:0x6398-source_address])
  if name!='baseline':expected[0x6300-0x5c50]=0x57
  need(text[328:]==bytes(expected),'replay exact emitted bytes')
