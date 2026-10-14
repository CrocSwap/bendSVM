"""Strict inventory for the conditional byte/word clear model."""
from pathlib import Path
import hashlib
if not __debug__:raise RuntimeError('assertions required')
ROOT=Path(__file__).resolve().parent
CLAIMS=['interval-does-not-wrap','outside-byte-frame','empty-fill-identity','inside-word-is-zero','outside-aligned-word-unchanged','word-membership-agrees']
SCOPE='Conditional byte-array zero-fill to aligned word-memory correspondence, plus actual interpreter summary comparisons for every supported count at region edges. Trusted syscall byte-fill/frame contract, valid disjoint regions, CALL ABI, solver and proof driver. This model check alone establishes no actual SBF artifact linkage or VM preservation.'
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def need(ok,why):
 if not ok:raise ValueError(why)
def validate(d):
 need(type(d) is dict and set(d)=={'passed','endToEndVerified','claims','controls','interpreterCases','inputs','scope'},'report fields')
 need(d['passed'] is True and d['endToEndVerified'] is False,'report status')
 need(d['claims']==[{'name':n,'result':'unsat'} for n in CLAIMS],'proof inventory/results')
 need(type(d['interpreterCases']) is int and d['interpreterCases']==769,'comparison inventory')
 need(d['scope']==SCOPE,'proof scope')
 need(type(d['controls']) is list and len(d['controls'])==2,'control inventory')
 for row,name in zip(d['controls'],['shifted-destination','missing-alignment']):
  need(type(row) is dict and set(row)=={'name','result','witness'} and row['name']==name and row['result']=='sat' and type(row['witness']) is str and bool(row['witness']),'semantic control')
 expected={str(ROOT/n) for n in ['check-sbf-zero-fill.py','sbf_output.py','sbf_cfg.py']}
 need(type(d['inputs']) is dict and set(d['inputs'])==expected,'source inventory')
 for p,h in d['inputs'].items():need(type(h) is str and h==sha(p),'source drift')
