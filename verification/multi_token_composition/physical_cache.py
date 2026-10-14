"""Same-qualification exact-query reuse for UNSAT lemmas only.

The proof producer and manifest validator remain trusted. This cache does not
infer UNSAT from a query hash alone; it requires a bound, completed producer
manifest and an exact parsed-assertion match under the same source and run identity.
"""
from pathlib import Path
import hashlib,json,re
import z3 as z

def digest(raw):return hashlib.sha256(raw).hexdigest()
def need(ok,why):
 if not ok:raise ValueError(why)
def encode(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()

class Producer:
 def __init__(self,folder,qualification,sources,names):
  self.folder=Path(folder).resolve();self.folder.mkdir(exist_ok=False)
  need(type(qualification) is str and bool(qualification),'qualification identity')
  need(type(sources) is dict and bool(sources),'source inventory')
  need(names and len(names)==len(set(names)) and all(re.fullmatch('[a-z0-9][a-z0-9-]*',n) for n in names),'query names')
  self.qualification=qualification;self.sources=dict(sources);self.names=list(names);self.rows=[]
 def check(self,name,solver):
  need(len(self.rows)<len(self.names) and name==self.names[len(self.rows)],'query order')
  raw=solver.to_smt2().encode();status=str(solver.check())
  if status!='unsat':
   (self.folder/('failed-'+name+'.smt2')).write_bytes(raw)
   (self.folder/('failed-'+name+'.json')).write_text(json.dumps({'name':name,'result':status,'reasonUnknown':solver.reason_unknown() if status=='unknown' else None,'countermodel':str(solver.model()) if status=='sat' else None},indent=2)+'\n')
   raise ValueError('lemma not UNSAT')
  (self.folder/(name+'.smt2')).write_bytes(raw)
  self.rows.append({'name':name,'result':status,'sha256':digest(raw)})
 def finish(self):
  need(len(self.rows)==len(self.names),'incomplete lemma producer')
  for p,h in self.sources.items():need(digest(Path(p).read_bytes())==h,'producer source drift')
  for row in self.rows:need(digest((self.folder/(row['name']+'.smt2')).read_bytes())==row['sha256'],'producer query drift')
  manifest={'qualification':self.qualification,'sources':self.sources,'queries':self.rows,'passed':True}
  raw=encode(manifest);(self.folder/'manifest.json').write_bytes(raw)
  return {'folder':str(self.folder),'manifestSha256':digest(raw)}

class Consumer:
 def __init__(self,receipt,qualification,sources,names):
  need(set(receipt)=={'folder','manifestSha256'},'receipt keys')
  self.folder=Path(receipt['folder']);raw=(self.folder/'manifest.json').read_bytes()
  need(digest(raw)==receipt['manifestSha256'],'manifest hash');m=json.loads(raw)
  need(set(m)=={'qualification','sources','queries','passed'} and m['passed'] is True,'manifest shape')
  need(m['qualification']==qualification,'qualification mismatch');need(m['sources']==sources,'source inventory mismatch')
  for p,h in sources.items():need(digest(Path(p).read_bytes())==h,'consumer source drift')
  need([r['name'] for r in m['queries']]==names,'query inventory')
  for r in m['queries']:
   need(set(r)=={'name','result','sha256'} and r['result']=='unsat','query result')
   need(re.fullmatch('[a-z0-9][a-z0-9-]*',r['name']) is not None,'query name')
   need(digest((self.folder/(r['name']+'.smt2')).read_bytes())==r['sha256'],'saved query hash')
  self.rows=m['queries'];self.next=0;self.receipt=dict(receipt);self.sources=dict(sources)
 def check(self,name,solver):
  need(self.next<len(self.rows) and self.rows[self.next]['name']==name,'query order')
  recorded=(self.folder/(name+'.smt2')).read_bytes()
  # Z3 printer-local let labels can vary across processes. Parsing removes
  # those bound aliases; require exact ordered assertion ASTs, not solver
  # equivalence, simplification, or an unchecked textual normalization.
  saved=list(z.parse_smt2_string(recorded.decode()));current=list(z.parse_smt2_string(solver.to_smt2()))
  need(len(saved)==len(current) and all(z.eq(a,b) for a,b in zip(saved,current)),'query formula mismatch')
  need(digest(recorded)==self.rows[self.next]['sha256'],'saved query hash')
  self.next+=1
 def finish(self):
  need(self.next==len(self.rows),'incomplete lemma consumer')
  need(digest((self.folder/'manifest.json').read_bytes())==self.receipt['manifestSha256'],'manifest drift')
  for p,h in self.sources.items():need(digest(Path(p).read_bytes())==h,'consumer source drift')
  for row in self.rows:need(digest((self.folder/(row['name']+'.smt2')).read_bytes())==row['sha256'],'consumer query drift')
  return {'reused':self.next,'manifestSha256':self.receipt['manifestSha256']}
