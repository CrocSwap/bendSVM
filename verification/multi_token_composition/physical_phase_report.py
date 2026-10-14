"""Strict shared/handler phase and assembled serialized evidence bindings."""
from pathlib import Path
import copy,json
from multi_token_composition.common import sha,need,NAMES,SCOPE,snapshot
from multi_token_composition import physical_report as physical
from loader_report import validate as loader_validate,unchanged

SHARED_SOURCES=['physical_shared.py','physical_handler.py','physical_cache.py','physical_primitives.py','physical_snapshot.py','physical_queries.json']
COMPONENTS=['physical_primitives','physical_snapshot','physical_prefix','physical_success','physical_selection','physical_ranges','physical_certificate','physical_commit','physical_domain','physical_memory']
CONTROLS={'translation':['missing-alignment','missing-nonwrapping-allocation','shifted-translated-store'],'patch':['missing-patch','shifted-snapshot-offset','missing-separation'],'store':['missing-separation','shifted-store-address']}

def exact(a,b):
 from multi_token_composition.report import exact as check
 check(a,b)

def read(path):return json.loads(Path(path).read_text())
def files(paths):return {str(p):sha(p) for p in paths}

def primitives(value,names):
 exact(sorted(value),['patch','ranges','store','translation']);physical.primitive_ranges(value['ranges'])
 witness={'translation':'highBaseWitness','patch':'nonemptyLastByteWitness','store':'nonemptyDomain'}
 for group,controls in CONTROLS.items():
  row=value[group];exact(sorted(row),sorted(['claims',witness[group]]));exact(row[witness[group]],'sat')
  claims=row['claims'];exact(len(claims),len(names[group])+len(controls))
  exact([c['name'] for c in claims if c['result']=='unsat'],names[group]);exact([c['name'] for c in claims if c['result']=='sat'],controls)
  for c in claims:
   need(c['result'] in ('sat','unsat'),'physical primitive result')
   exact(sorted(c),['name','result','witness'] if c['result']=='sat' else ['name','result'])
   if c['result']=='sat':need(type(c['witness']) is str and bool(c['witness']),'physical primitive countermodel')

def query_names(name,names):
 result={name+'-mode'+str(mode)+'.smt2' for mode in (0,1)}
 for group in CONTROLS:
  result.update('physical-primitives/'+group+'/'+claim+'.smt2' for claim in names[group]+CONTROLS[group])
 result.update('snapshot-chain/'+claim+'.smt2' for claim in names['snapshots']+['omitted-first-snapshot','omitted-separation'])
 result.update(name+'-physical-ranges/'+claim+'.smt2' for claim in physical.range_names())
 return result

def validate(rows,fixtures,folder,extra):
 import multi_adapter_contract as adapter
 need(__debug__,'assertions required');folder=Path(folder).resolve();base=Path(__file__).resolve().parent
 inp=folder.parent/'fixtures/input.json';binding={'input':str(inp),'inputSha256':sha(inp),'sourceHashes':snapshot()}
 names=read(base/'physical_queries.json');receipt=folder/'loader-receipt.json';loader=read(receipt)
 raw=Path(loader['inputArtifact']).read_bytes();loader_input=json.loads(raw)
 loader_validate(read(loader['reportArtifact']),loader_input,raw);unchanged(loader_input)
 loader_base={str(receipt):sha(receipt),loader['inputArtifact']:loader['inputSha256'],loader['reportArtifact']:loader['reportSha256']}
 for p,h in loader_base.items():exact(sha(p),h)
 source_files=files(base/n for n in SHARED_SOURCES);cache_sources={**binding['sourceHashes'],**source_files}
 def phase(name,kind):
  path=folder/name/'report.json';value=read(path)
  exact(sorted(value),['binding','extraInputs','fixtures','kind','passed','scope']);exact(value['passed'],True);exact(value['kind'],kind);exact(value['scope'],SCOPE);exact(value['binding'],binding);exact(len(value['fixtures']),1)
  loader_validate(read(folder/name/'loader-replay.json'),loader_input,raw)
  return value
 shared=phase('shared','staged-physical-shared');shared_dir=folder/'shared';s=shared['fixtures'][0]
 exact(sorted(s),['primitives','qualification','receipts','snapshots','sourceHashes']);exact(s['qualification'],str(shared_dir));exact(s['sourceHashes'],cache_sources);exact(sorted(s['receipts']),sorted(names))
 shared_extra={**source_files,**loader_base,**files([shared_dir/'loader-replay.json'])}
 for group,claims in names.items():
  cache=shared_dir/('cache-'+group);manifest_path=cache/'manifest.json';manifest=read(manifest_path)
  exact(s['receipts'][group],{'folder':str(cache),'manifestSha256':sha(manifest_path)})
  exact(sorted(manifest),['passed','qualification','queries','sources']);exact(manifest['passed'],True);exact(manifest['qualification'],str(shared_dir));exact(manifest['sources'],cache_sources)
  exact(manifest['queries'],[{'name':claim,'result':'unsat','sha256':sha(cache/(claim+'.smt2'))} for claim in claims])
  exact(sorted(p.name for p in cache.glob('*.smt2')),sorted(claim+'.smt2' for claim in claims))
  shared_extra.update(files([manifest_path,*[cache/(claim+'.smt2') for claim in claims]]))
 exact(shared['extraInputs'],shared_extra);primitives(s['primitives'],names);physical.snapshots(s['snapshots'])
 expected={**shared_extra,**files([shared_dir/'report.json',base/'physical_assemble.py',base/'physical_report.py',folder/'loader-replay.json'])}
 need((folder/'loader-replay.json').read_bytes()==(shared_dir/'loader-replay.json').read_bytes(),'shared loader replay copy')
 exact([r['name'] for r in rows],NAMES)
 for public,f,name in zip(rows,fixtures,NAMES):
  child_dir=folder/name;child=phase(name,'staged-physical-handler');row=child['fixtures'][0];exact(row['name'],name)
  summary=adapter.summarize(f['schema'],f['interface']);managed=[x['index'] for x in summary['fields']];lengths={x['index']:x['stateBytes'] for x in summary['fields']}
  physical.physical(row['physical'],int(name[-1]),managed,lengths)
  reuse=read(child_dir/'cache-reuse.json');exact(reuse,{g:{'reused':len(claims),'manifestSha256':s['receipts'][g]['manifestSha256']} for g,claims in names.items()})
  components=read(child_dir/'physical-components.json');exact(sorted(components),['primitives','snapshots']);primitives(components['primitives'],names);physical.snapshots(components['snapshots'])
  queries=read(child_dir/'physical-queries.json');expected_queries=query_names(name,names)
  exact(sorted(str(p.relative_to(child_dir)) for p in child_dir.rglob('*.smt2')),sorted(expected_queries));exact(queries,{p:sha(child_dir/p) for p in expected_queries})
  child_extra={**shared_extra,**files([shared_dir/'report.json',*[base/(n+'.py') for n in COMPONENTS],child_dir/'loader-replay.json',child_dir/'physical-components.json',child_dir/'physical-queries.json',child_dir/'cache-reuse.json',*[child_dir/p for p in expected_queries]])}
  exact(child['extraInputs'],child_extra)
  assembled=copy.deepcopy(row)
  exact([w['mode'] for w in assembled['activeWitnesses']],[0,1])
  for witness in assembled['activeWitnesses']:
   original=child_dir/(name+'-mode'+str(witness['mode'])+'.smt2');public_query=folder/original.name
   exact(witness['queryArtifact'],str(original));exact(witness['querySha256'],sha(original));need(public_query.read_bytes()==original.read_bytes(),'public witness copy');witness['queryArtifact']=str(public_query);expected[str(public_query)]=sha(public_query)
  exact(public,assembled)
  expected.update(child_extra);expected[str(child_dir/'report.json')]=sha(child_dir/'report.json')
 exact(extra,expected)
 unchanged(loader_input)
