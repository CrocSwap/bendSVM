"""Exact stage inventory and dependency bindings for linear source composition."""
import json,pathlib,sys,math
if not __debug__:raise RuntimeError('linear width reports require assertions')
from signed_report import validate as validate_signed
from modular_report import sha,snapshot
from modular_c import refs,need
SPECS=[{'report': 'report.json', 'input': 'input.json', 'checker': 'linear_width_product.py', 'keys': ['passed', 'inputSha256', 'checkerSha256', 'sourceHashes', 'claims', 'scope'], 'scope': 'Actual exported signed-byte product equivalence on byte inputs; separate bounded accumulation induction and sign-extension theorem. Not whole-linear equivalence, malformed-input behavior, emitted-C proof or measured CU improvement.', 'claims': [('actual-source-product-signs-00', 'unsat'), ('actual-source-product-signs-01', 'unsat'), ('actual-source-product-signs-10', 'unsat'), ('actual-source-product-signs-11', 'unsat'), ('signed-byte-product-bound', 'unsat'), ('32-term-prefix-range-induction', 'unsat'), ('bounded-add-signextension-preservation', 'unsat'), ('unsigned-byte-mutant', 'sat'), ('missing-accumulator-bound', 'sat')]}, {'report': 'candidate-proof.json', 'input': 'candidate-model.json', 'checker': 'linear_width_step.py', 'keys': ['passed', 'inputSha256', 'prerequisiteSha256', 'checkerSha256', 'claims', 'scope'], 'scope': 'Actual candidate helpers and single-step preservation; original-product summary freshly bound to prior universal byte theorem. Explicit accumulation bounds, inactive arbitrary payloads and invalid-byte validity propagation. Whole fold and final rejection composition still pending.', 'claims': [('candidate-byte-product', 'unsat'), ('candidate-bounded-add', 'unsat'), ('candidate-add-needs-bound', 'sat'), ('active-byte-step-preservation', 'unsat'), ('inactive-step-all-payloads', 'unsat'), ('active-invalid-byte-clears-validity', 'unsat'), ('failed-validity-cannot-recover', 'unsat')]}, {'report': 'composition-proof.json', 'input': 'composition-model.json', 'checker': 'linear_width_composition.py', 'keys': ['passed', 'inputSha256', 'prerequisiteSha256', 'checkerSha256', 'claims', 'traces', 'identicalDownstreamFunctions', 'scope'], 'scope': 'Actual fold traversal and final-output relation, with bound prior helper proofs and structurally identical downstream arithmetic. Prefix bound/invariant composition remains an explicit trusted-driver argument; no emitted C or SBF theorem.', 'claims': [('final-output-respects-validity-relation', 'unsat'), ('invalid-prefix-relation-preserved', 'unsat'), ('step-control-fields-all-payloads', 'unsat'), ('inactive-prefix-bound-widens', 'unsat'), ('all-prefixes-fit-signed32', 'unsat'), ('initial-prefix-is-zero', 'unsat'), ('original-actual-fold-32-ordered-steps', 'unsat'), ('candidate-actual-fold-32-ordered-steps', 'unsat')]}]

def validate(root):
 inputs={s['input']:json.loads((root/s['input']).read_text()) for s in SPECS}
 first=inputs['input.json'];before=first['sourceHashes'];need(before and snapshot(before)==before,'source binding')
 need(isinstance(first['runId'],str) and len(first['runId'])==36,'run id')
 for value in inputs.values():need(value['runId']==first['runId'] and value['sourceHashes']==before,'shared run/source identity')
 need(first['source']['source']=='benchmarks/linear-wide.bend' and first['source']['roots']==['product'],'original product fixture')
 for name,roots in [('candidate-model.json',['product','advance_if']),('composition-model.json',['product','advance_if','fold_rows','finish_sum','linear'])]:
  value=inputs[name];need(value['original']['source']=='benchmarks/linear-wide.bend' and value['candidate']['source']=='benchmarks/linear.bend','fixture identity')
  need(value['original']['roots']==roots and value['candidate']['roots']==[roots[0],'../sdk/signed.add32_wrap',*roots[1:]],'root identity')
 for i,s in enumerate(SPECS):
  report=json.loads((root/s['report']).read_text());need(set(report)==set(s['keys']) and report['passed'] is True and report['scope']==s['scope'],'stage fields/scope')
  need(report['inputSha256']==sha((root/s['input']).read_bytes()),'stage input hash')
  checker='verification/'+s['checker'];need(report['checkerSha256']==before[checker]==sha(pathlib.Path(checker).read_bytes()),'checker binding')
  need([(r['name'],r['result']) for r in report['claims']]==[tuple(c) for c in s['claims']],'claim inventory')
  for row in report['claims']:
   need(set(row)==({'name','result','seconds','witness'} if row['result']=='sat' else {'name','result','seconds'}),'claim fields')
   need(type(row['seconds']) in (float,int) and math.isfinite(row['seconds']) and row['seconds']>=0,'timing')
   if row['result']=='sat':need(isinstance(row['witness'],str) and row['witness'].strip(),'missing counterexample')
  if i:need(report['prerequisiteSha256']==sha((root/SPECS[i-1]['report']).read_bytes()),'stage prerequisite')
  else:need(report['sourceHashes']==before,'product source binding')
 final=json.loads((root/'composition-proof.json').read_text());full=inputs['composition-model.json']
 need(final['traces']==[{'fixture':'benchmarks/linear-wide.bend','steps':32},{'fixture':'benchmarks/linear.bend','steps':32}],'fold trace inventory')
 original=full['original']['functions'];candidate=full['candidate']['functions'];seen=set()
 def visit(name):
  if name in seen:return
  need(original[name]==candidate[name],'downstream changed');seen.add(name)
  for child in refs(original[name].get('body')):visit(child)
 visit('linear_output');need(final['identicalDownstreamFunctions']==sorted(seen),'downstream inventory')
 receipt=json.loads((root/'sdk-receipt.json').read_text());raw=pathlib.Path(receipt['inputArtifact']).read_bytes();sdk=json.loads(raw)
 need(receipt['passed'] is True and receipt['inputSha256']==sha(raw) and receipt['reportSha256']==sha(pathlib.Path(receipt['reportArtifact']).read_bytes()),'SDK receipt')
 validate_signed(json.loads(pathlib.Path(receipt['reportArtifact']).read_text()),sdk,raw)
 for path,h in receipt['sourceHashes'].items():need(before.get(path)==h,'SDK source binding')
 normalize=lambda v:json.loads(json.dumps(v).replace('../sdk/signed.','').replace('../sdk/math.','math.'))
 imported={normalize(n):normalize(f) for n,f in candidate.items()}
 for name,definition in sdk['program']['source']['functions'].items():need(imported[name]==definition,'SDK definition binding')
 print('Linear proof inventories, SDK definitions, sources and stage bindings passed')
if __name__=='__main__':validate(pathlib.Path(sys.argv[1]))
