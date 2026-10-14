"""Discharge clear-interval premises using already validated handler reports.

The caller must strictly validate the four reports and wrapper relocation first.
This module does not replace their instruction or artifact checks.
"""
from pathlib import Path
from sbf_zero_fill_report import need,sha,validate
EXPECTED={'claim-output-report.json':[(0x2e38,248,112)],'initialize-output-report.json':[(0x1e60,248,112)],'rejection-output-report.json':[(0x2470,8,352),(0x2e38,248,112)]}
def connect(proof,reports):
 validate(proof)
 need(set(reports)==set(EXPECTED)|{'memset-wrapper-report.json'},'clear report inventory')
 wrapper=reports['memset-wrapper-report.json']
 images={p:h for p,h in wrapper['inputHashes'].items() if p.endswith('/vesting.so')}
 need(len(images)==1,'clear wrapper image')
 for p,h in images.items():need(sha(p)==h,'clear image drift')
 sites=[]
 for name,wanted in EXPECTED.items():
  d=reports[name]
  need({p:h for p,h in d['inputHashes'].items() if p.endswith('/vesting.so')}==images,'clear shared image')
  models=[h for p,h in d['inputHashes'].items() if p.endswith('/verification/sbf_output.py')]
  need(models==[sha(Path(__file__).with_name('sbf_output.py'))],'clear model identity')
  calls=d['calls'] if 'calls' in d else [c for case in d['cases'] for c in case['calls']]
  need(len(calls)==len(wanted),'clear call inventory')
  for c,(address,offset,count) in zip(calls,wanted):
   need(type(c) is dict and set(c)=={'address','target','region','offset','bytes'},'clear call fields')
   need(all(type(c[k]) is int for k in ['address','target','offset','bytes']),'clear call types')
   need(c=={'address':address,'target':0x6890,'region':'output','offset':offset,'bytes':count},'clear call binding')
   need(offset%4==count%4==0 and 0<=offset<=offset+count<=360<=1536,'clear byte-word premises')
   sites.append({'reportRole':name,**c})
 return {'passed':True,'endToEndVerified':False,'callSites':sites,'elfHashes':images,'scope':'Four strictly validated handler clear instances meet the conditional byte/word bridge premises and share the checked wrapper ELF. Syscall byte-write/frame behavior, valid disjoint allocation and VM CALL semantics remain assumptions.'}
