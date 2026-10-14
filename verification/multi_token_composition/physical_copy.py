"""Relocate private phase evidence in report-corruption test copies.

Loader input/report artifacts retain their original immutable references, as in
the existing loader receipt copy protocol. Source and fixture bytes are unchanged.
"""
from pathlib import Path
import copy,json
from multi_token_composition.common import sha,NAMES,need

def relocate(source,folder,public):
 source=Path(source).resolve();folder=Path(folder).resolve();public=copy.deepcopy(public)
 read=lambda p:json.loads(Path(p).read_text())
 def write(p,value):Path(p).write_text(json.dumps(value,indent=2)+'\n')
 loader=read(folder/'loader-receipt.json');fixed={loader['inputArtifact'],loader['reportArtifact']}
 def path(p):
  if p in fixed:return p
  return str(folder)+p[len(str(source)):] if p==str(source) or p.startswith(str(source)+'/') else p
 def extras(value):
  return {path(p):sha(path(p)) for p in value}
 shared_dir=folder/'shared';shared=read(shared_dir/'report.json');row=shared['fixtures'][0]
 row['qualification']=str(shared_dir)
 for name,receipt in row['receipts'].items():
  cache=shared_dir/('cache-'+name);manifest=read(cache/'manifest.json');manifest['qualification']=str(shared_dir);write(cache/'manifest.json',manifest)
  receipt['folder']=str(cache);receipt['manifestSha256']=sha(cache/'manifest.json')
 shared['binding']['input']=public['binding']['input'];shared['extraInputs']=extras(shared['extraInputs']);write(shared_dir/'report.json',shared)
 for name in NAMES:
  child_dir=folder/name;reuse=read(child_dir/'cache-reuse.json')
  for group,value in reuse.items():value['manifestSha256']=row['receipts'][group]['manifestSha256']
  write(child_dir/'cache-reuse.json',reuse)
  child=read(child_dir/'report.json');child['binding']['input']=public['binding']['input']
  for witness in child['fixtures'][0]['activeWitnesses']:witness['queryArtifact']=path(witness['queryArtifact'])
  child['extraInputs']=extras(child['extraInputs']);write(child_dir/'report.json',child)
 for row in public['fixtures']:
  for witness in row['activeWitnesses']:witness['queryArtifact']=path(witness['queryArtifact'])
 public['extraInputs']=extras(public['extraInputs'])
 return public
