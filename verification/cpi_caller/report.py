"""CPI caller report inventory checks; proof execution and freshness checked separately."""
import hashlib

CLAIMS = (
 'ordered-return-contract', 'root-context-before-instruction',
 'all-encodes-validation-execution-before-commit',
 'no-adapter-writes-on-explicit-failure',
 'exact-per-account-header-binding-payload-and-reply', 'encode-source-field-binding',
)
EXTRACTION = (
 'typed-effect-path-coverage', 'typed-effect-never-rejected',
 'typed-effect-path-disjointness', 'None-mapping-0', 'Invoke-mapping-0',
 'plural-typed-path-coverage', 'plural-typed-path-disjointness',
 'plural-fixed-record-never-rejected', 'plural-slot-0-all-fields',
 'plural-slot-1-all-fields',
)
INVENTORY = {
 'cpi-2': (78, 413, 1047, 4, 67, 268, 23),
 'cpi-3': (164, 869, 2295, 8, 78, 624, 40),
 'cpi-4': (344, 1789, 5167, 16, 89, 1424, 73),
}
OBLIGATION_GROUPS = {'cpi-2': ['obligation: pointer: read through a possibly null pointer', 'obligation: account: read of an account the loader parser did not fill', 'obligation: loader: instruction located after exactly `count` accounts', 'obligation: pointer: arithmetic on a possibly null pointer', 'obligation: bounds: instruction read within the instruction length', 'obligation: helper: receives an account the loader parser did not fill', 'obligation: loader: program id read at the end of the instruction', 'obligation: loader: program id follows instruction', 'obligation: bounds: managed data read within account size', 'obligation: uninitialized: helper output read without success', 'obligation: union: outcome field read while another variant is active', 'obligation: union: Accepted.state address while another outcome variant is active', 'obligation: union: state result field read while Accepted is inactive', 'obligation: union: state field 0 encoded while Accepted is inactive', 'obligation: union: state field 1 encoded while Accepted is inactive', 'obligation: effects: slot read without successful extraction', 'obligation: helper: account count exceeds the account array', 'obligation: helper: validator account count differs from loader', 'obligation: actual-effects: full-width helper count', 'obligation: helper: executor account count differs from loader', 'obligation: helper: executor bump differs from custody output', 'obligation: bounds: managed data write within account size'], 'cpi-3': ['obligation: pointer: read through a possibly null pointer', 'obligation: account: read of an account the loader parser did not fill', 'obligation: loader: instruction located after exactly `count` accounts', 'obligation: pointer: arithmetic on a possibly null pointer', 'obligation: bounds: instruction read within the instruction length', 'obligation: helper: receives an account the loader parser did not fill', 'obligation: loader: program id read at the end of the instruction', 'obligation: loader: program id follows instruction', 'obligation: bounds: managed data read within account size', 'obligation: uninitialized: helper output read without success', 'obligation: union: outcome field read while another variant is active', 'obligation: union: Accepted.state address while another outcome variant is active', 'obligation: union: state result field read while Accepted is inactive', 'obligation: union: state field 0 encoded while Accepted is inactive', 'obligation: union: state field 1 encoded while Accepted is inactive', 'obligation: union: state field 2 encoded while Accepted is inactive', 'obligation: effects: slot read without successful extraction', 'obligation: helper: account count exceeds the account array', 'obligation: helper: validator account count differs from loader', 'obligation: actual-effects: full-width helper count', 'obligation: helper: executor account count differs from loader', 'obligation: helper: executor bump differs from custody output', 'obligation: bounds: managed data write within account size'], 'cpi-4': ['obligation: pointer: read through a possibly null pointer', 'obligation: account: read of an account the loader parser did not fill', 'obligation: loader: instruction located after exactly `count` accounts', 'obligation: pointer: arithmetic on a possibly null pointer', 'obligation: bounds: instruction read within the instruction length', 'obligation: helper: receives an account the loader parser did not fill', 'obligation: loader: program id read at the end of the instruction', 'obligation: loader: program id follows instruction', 'obligation: bounds: managed data read within account size', 'obligation: uninitialized: helper output read without success', 'obligation: union: outcome field read while another variant is active', 'obligation: union: Accepted.state address while another outcome variant is active', 'obligation: union: state result field read while Accepted is inactive', 'obligation: union: state field 0 encoded while Accepted is inactive', 'obligation: union: state field 1 encoded while Accepted is inactive', 'obligation: union: state field 2 encoded while Accepted is inactive', 'obligation: union: state field 3 encoded while Accepted is inactive', 'obligation: effects: slot read without successful extraction', 'obligation: helper: account count exceeds the account array', 'obligation: helper: validator account count differs from loader', 'obligation: actual-effects: full-width helper count', 'obligation: helper: executor account count differs from loader', 'obligation: helper: executor bump differs from custody output', 'obligation: bounds: managed data write within account size']}

class InvalidReport(ValueError): pass

def require(condition, reason):
 if not condition: raise InvalidReport(reason)

def named(rows, expected, label):
 require(type(rows) is list, label)
 require([x['name'] for x in rows] == list(expected), label+' inventory/order')
 require(all(x['result'] == 'unsat' for x in rows), label+' unproved')

def validate(report, fixtures):
 require(report['passed'] is True, 'not passed')
 require([r['fixture'] for r in report['rows']] == list(INVENTORY), 'fixture inventory')
 require([f['name'] for f in fixtures] == list(INVENTORY), 'input inventory')
 for row, fixture in zip(report['rows'], fixtures):
  a = row['adapter']; name = fixture['name']
  expected = INVENTORY[name]
  observed = (a['paths'], a['rawPaths'], a['modelObligations'], row['rootCalls'],
              row['domainBinding']['outputs'], row['bridgeEqualities'], len(row['prunedBranchQueries']))
  require(observed == expected and all(type(n) is int for n in observed), name+' counts')
  require(a['fixture'] == name, 'adapter fixture')
  require(set(a['claims']) == set(CLAIMS), 'caller claim inventory')
  require(all(v == {'result':'unsat','counterexamples':0} for v in a['claims'].values()), 'caller claim result')
  require(row['actualRootSafety'] == 'unsat', 'root safety')
  require(row['custodySuccessContract'] == 'unsat', 'custody success contract')
  named(row['obligationProofs'], OBLIGATION_GROUPS[name], 'obligation groups')
  for proof in row['obligationProofs']:
   if proof['method'] == 'stronger query over exact fresh pruning lemmas':
    require(type(proof['lemmas']) is int and proof['lemmas'] == expected[-1], 'obligation pruning lemmas')
   elif proof['method'] == 'full binding query':
    require(proof['reducedResult'] in ('sat','unknown'), 'obligation fallback result')
   else: raise InvalidReport('obligation proof method')
  require(row['rootCorrespondence'] == [{'function':'process','result':'unsat','CGuardObligations':14+3*(int(name[-1])-2),'sourceDeadPaths':1}], 'source/C root correspondence')
  require(a['adapterSha256'] == hashlib.sha256(fixture['files'][fixture['adapter']].encode()).hexdigest(), 'adapter hash')
  require(a['files'] == {n:hashlib.sha256(s.encode()).hexdigest() for n,s in fixture['files'].items()}, 'include hashes')
  partitions = row['composedPathPartitions']
  require([x['query'] for x in partitions] == [0,1], 'partition inventory')
  require(all(x['result'] == 'unsat' and x['freshPrunedBranchLemmas'] == expected[-1] for x in partitions), 'partition proof')
  named(row['semanticProofs'], CLAIMS, 'semantic claims')
  extraction = row['typedExtraction']
  named(extraction['claims'], EXTRACTION, 'extraction')
  require((extraction['singlePaths'], extraction['pluralPaths'], extraction['slots'], extraction['fieldsPerSlot']) == (3,4,2,380), 'extraction counts')
  domain = row['domainBinding']
  named(domain['claims'], ('assignments-to-shared-outputs-have-disjoint-guards', 'every-base-input-extends-to-output-and-encoding-bindings'), 'domain claims')
  require(len(domain['instances']) == expected[4], 'domain instances')
  require(len({x['output'] for x in domain['instances']}) == expected[4], 'duplicate domain output')
  lemmas = domain['genericLemmas']
  require(bool(lemmas) and all(x['result'] == 'unsat' for x in lemmas), 'domain lemmas')
  lemma_names = [x['name'] for x in lemmas]
  require(len(set(lemma_names)) == len(lemma_names), 'duplicate domain lemma')
  require(set(lemma_names) == {'generic-disjoint-choice-'+x['lemma'] for x in domain['instances']}, 'domain lemma references')
  require(all(type(x['assignments']) is int and x['assignments'] > 0 for x in domain['instances']), 'domain assignment count')
  for item in row['prunedBranchQueries']:
   require(item['result'] == 'unsat', 'pruning result')
   for key in ('formulaSha256','assertionsSha256'):
    value=item[key]; require(type(value) is str and len(value)==64 and all(c in '0123456789abcdef' for c in value), 'pruning hash')
  witnesses = row['completeCallerWitnesses']
  require([x['mode'] for x in witnesses] == [0,1], 'witness modes')
  for witness in witnesses:
   require(witness['result'] == 'sat' and bool(witness['model']), 'missing success witness')
   data=witness['instructionBytes']
   require(bool(data) and data[0]==witness['mode'] and all(type(x) is int and 0<=x<=255 for x in data), 'witness bytes')
 return True
