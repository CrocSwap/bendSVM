import assert from 'node:assert/strict';
import crypto, {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root = process.cwd();
const receipt = process.env.COLLECTION_LIFECYCLE_RECEIPT_PATH ?? 'build/collection-lifecycle-refinement.json';
const pending = receipt + '.pending';
const pendingTmp = pending + '.tmp';
const publishTmp = receipt + '.publish.tmp';
const python = process.env.PYTHON ?? 'python3';
const inputs = [
  'runtime/bend_collection_runtime.h',
  'runtime/solana_min.h',
  'verification/collection_lifecycle.py',
  'verification/check-collection-lifecycle.ts',
  'verification/collection_runtime.py',
  'verification/adapter_contract_c.py',
  'verification/collection_contracts.py',
];
const helperInputs = inputs.slice(4);

const openClaims = [
  'open exact ordered error/success contract',
  'open C reads stay within caller-provided objects',
  'open every path returns',
  'open return paths are exclusive',
  'refusal preserves output object',
  'success writes exact collection fields',
  'open Account object remains unchanged on success and refusal',
  'open refusal preserves the Account object',
  'open evaluated signed arithmetic and shifts avoid C undefined behavior',
  'open C short-circuit skips undefined arithmetic in an unevaluated operand',
  'open unsigned division/remainder yields exact capacity payload relation',
];
const recordClaims = [
  'record size input matches its C bitvector',
  'record length input matches its C bitvector',
  'record capacity input matches its C bitvector',
  'record stride input matches its C bitvector',
  'record start input matches its C bitvector',
  'record reserved input matches its C bitvector',
  'record loaded input matches its C bitvector',
  'record local input matches its C bitvector',
  'record exact null/non-null guard',
  'record address is exact 56 + (start + local) * stride',
  'record u32 index addition does not wrap',
  'record C-width address arithmetic does not wrap',
  'record returned stride lies within opened allocation',
  'record names a logical active record',
  'record intermediate pointer formations and evaluated byte reads stay within caller-provided objects',
];
const commitClaims = [
  'commit size input matches its C bitvector',
  'commit length input matches its C bitvector',
  'commit capacity input matches its C bitvector',
  'commit stride input matches its C bitvector',
  'commit start input matches its C bitvector',
  'commit reserved input matches its C bitvector',
  'commit loaded input matches its C bitvector',
  'commit written input matches its C bitvector',
  'commit next length input matches its C bitvector',
  'commit scratch extent input matches its C bitvector',
  'commit exact header/length/key/window bytes and unchanged outside',
  'commit writes the planned logical length',
  'commit record range stays disjoint from header',
  'commit parsed pointer formations and byte spans match bounded object ranges',
  'commit C-width count, stride and address calculations do not wrap',
  'commit actual C subscripts match summarized copy addresses',
  'commit copy summaries match C address/count values and terminate',
];
const claimNames = [...openClaims, ...recordClaims, ...commitClaims];
const recordCorrespondenceApplications = [
  {name:'record size input matches its C bitvector',width:64},
  ...['length','capacity','stride','start','reserved','loaded','local']
    .map((name) => ({name:`record ${name} input matches its C bitvector`,width:32})),
];
const commitCorrespondenceApplications = [
  {name:'commit size input matches its C bitvector',width:64},
  ...['length','capacity','stride','start','reserved','loaded','written','next length']
    .map((name) => ({name:`commit ${name} input matches its C bitvector`,width:32})),
  {name:'commit scratch extent input matches its C bitvector',width:64},
];
const correspondenceApplications = [
  ...recordCorrespondenceApplications, ...commitCorrespondenceApplications,
];
const genericArithmeticRegressionNames = [
  'open C short-circuit skips undefined arithmetic in an unevaluated operand',
  'open unsigned division/remainder yields exact capacity payload relation',
];
const correspondenceApplicationNames = new Set(correspondenceApplications.map((item) => item.name));
const genericArithmeticRegressionNameSet = new Set(genericArithmeticRegressionNames);
const independentRuntimeClaimNames = claimNames.filter((name) =>
  !correspondenceApplicationNames.has(name) && !genericArithmeticRegressionNameSet.has(name));

const mutationCases = [
  ['open wrong owner key', 'semantic'],
  ['open omits writable validation', 'semantic'],
  ['open omits initialization signer', 'semantic'],
  ['open omits initialization zero scan', 'semantic'],
  ['open header range is short', 'semantic'],
  ['open uses wrong stored key offset', 'semantic'],
  ['open uses wrong length offset', 'semantic'],
  ['open omits stored length capacity bound', 'semantic'],
  ['open weakens payload divisibility', 'semantic'],
  ['open capacity u32 ceiling is too small', 'semantic'],
  ['record accepts local equal to loaded', 'semantic'],
  ['record header offset is short', 'semantic'],
  ['record scales local but not start', 'semantic'],
  ['record unsigned unary minus changes address', 'semantic'],
  ['record signed division truncates toward zero', 'semantic'],
  ['record proves every evaluated byte read in bounds', 'semantic'],
  ['commit omits collection header from range', 'semantic'],
  ['commit writes only half the planned record bytes', 'semantic'],
  ['commit short header write', 'semantic'],
  ['commit writes length at wrong offset', 'semantic'],
  ['commit writes state key at wrong offset', 'semantic'],
  ['commit records old length', 'semantic'],
  ['commit narrows declared u64 offset to u32 at initialization', 'semantic'],
  ['commit narrows declared u64 offset to u32 on assignment', 'semantic'],
  ['commit u32 base plus induction wraps the actual C subscript', 'semantic'],
  ['commit unsigned unary minus wraps its offset', 'semantic'],
  ['commit unsigned intermediate offset wraps before pointer use', 'semantic'],
  ['commit unsigned unary minus wraps its count', 'semantic'],
  ['commit rejects out-of-bounds read in write_le value', 'semantic'],
  ['commit rejects wrapped intermediate read_le pointer', 'semantic'],
  ['record rejects compensated out-of-object pointer formation', 'grammar'],
  ['commit rejects compensated pointer-derived base', 'grammar'],
  ['commit rejects computed pointer base outside object', 'grammar'],
  ['commit rejects out-of-bounds read in copied index base', 'grammar'],
  ['open signed addition overflow is rejected', 'undefined_behavior'],
  ['open out-of-range shift count is rejected', 'undefined_behavior'],
  ['open negative signed left shift is rejected', 'undefined_behavior'],
  ['record rejects unsigned octal integer literal', 'grammar'],
  ['commit rejects signed octal integer literal', 'grammar'],
  ['open rejects Account signer field mutation', 'grammar'],
  ['open rejects Account writable field mutation', 'grammar'],
  ['open rejects Account owner field mutation', 'grammar'],
  ['open rejects account-data byte mutation', 'grammar'],
  ['open rejects loop-induction mutation that skips alternate header bytes', 'grammar'],
  ['open rejects braced loop-induction mutation', 'grammar'],
  ['open rejects nonmonotonic i!=100 loop guard', 'grammar'],
  ['open rejects memory-derived loop bound', 'grammar'],
  ['commit rejects const-derived collection-data write', 'grammar'],
  ['commit rejects mutable alias of const-derived pointer', 'grammar'],
] as const;
const equivalentNames = [
  'open owner/executable check order',
  'record split u32 sum cast',
  'record combine pointer offset into one formation',
  'commit header loop before record loop',
  'commit zero-offset pointer alias preserves byte layout',
  'open braced loop body preserves first-false semantics',
  'open redundant condition parentheses',
  'record negated strict comparison',
  'open short-circuit excludes unevaluated signed overflow',
  'record unsigned unary negation wraps in C',
  'record signed division truncates toward zero',
  'record signed remainder truncates toward zero',
  'record usual conversions widen before addition',
];
const expectedGrammarRestrictions = {
  open:[
    'only the BendCollection output receives a whole-structure store; Account member stores reject',
    'indexed stores, including account-data and const-derived stores, reject',
    'loop summaries quantify the full sequential index range only for zero-based unsigned unit increments with induction < an invariant bound, no induction or other state writes, and one constant early-return value',
    'scalar const writes reject and const-derived pointer stores reject',
    'output account-pointer identity follows the admitted aggregate assignment shape rather than a solver claim',
  ],
  record:[
    'record reads are limited to modeled scalar and byte-array expressions',
    'the returned pointer uses one scalar-combined or two sequential pointer formations from account data; with two, the first formation is directly checked in C bitvectors, while the final address is tied to the exact-address, C-width no-wrap, input-correspondence and active-record span claims',
    'loop summaries require zero-based unsigned unit increments guarded by induction < invariant-bound; the exact monotonic guard enumerates the visited range',
  ],
  commit:[
    'copy loops require zero-based unit-increment induction < invariant-bound guards',
    'indexed writes target only collection data; source and destination indices are base + induction',
    'write_le accepts only the reviewed collection-data destination and four-byte use',
    'commit pointer, count, induction and byte memory semantics use C bitvectors; external integer input labels are separately proved equal to the corresponding unsigned bitvector inputs',
    'pointer variables are direct aliases or use one constant in-object base offset proved against the actual bitvector extent; variable-index addresses map pointwise to their parsed C subscript and exact loop span, and write_le maps to its fixed four-byte target span',
    'each admitted counted copy proves that its parsed C subscript equals the widened base-plus-induction address on every executed iteration',
    'each admitted counted copy is bounded and nonwrapping at both objects using the actual u64 pointer, count and extent values',
    'non-summary scalar/helper byte reads are separately SMT-checked; counted-copy and fixed-write accesses use their summarized span theorems',
    'const scalar and const-derived pointer writes reject before symbolic analysis',
    'local declarations and assignments use parsed declared C types and conversions',
  ],
};
const expectedAssumptions = {
  'C semantics':'Every evaluated scalar, promotion, conversion, division, remainder, shift and pointer offset uses fixed-width C bitvectors and the hash-bound conversion rules; signed division and remainder use C truncation toward zero, and unsigned unary negation wraps at its promoted width. Record/commit integer input correspondence is instantiated from one cached UNSAT Int2BV inverse query per supported width (32 and 64), with 18 applications of those two results; these are not 18 independent solver queries. In admitted code, the u32-by-u32 offset/count products are widened to u64 and fit because (2^32-1)^2 < 2^64; the active record u32 start+local sum has its own UNSAT no-wrap claim. Commit proves the parsed C subscript equals the widened base-plus-induction address for every guarded iteration. Mathematical span/no-wrap and exact bitvector address results are separate obligations; their composition to conclude the actual source pointer is in range relies on the stated source-width/range reasoning, not one combined Z3 query. Signed overflow, invalid division and invalid shifts fail path-sensitive obligations. Signed right shift and pointer/object representation remain pinned-target assumptions.',
  'commit caller facts':'Each commit input label for account, collection, window, written, next length and scratch extent has its own proved C-bitvector correspondence claim. Successful plan establishes loaded<=written<=reserved, oldLength<=nextLength<=capacity, written-loaded=nextLength-oldLength, and, when appending, oldLength-start=loaded; encoded extent>=written*stride. Parsed C copy addresses/counts are checked as bitvectors, including the actual per-iteration base+induction subscript. Integer span obligations use the individually mapped inputs and source-typed u32-by-u32 products widened to u64; the explicit operand-width bound makes those products exact, and the caller ranges establish object bounds/no-wrap. Source spans are disjoint from collection data and each other, and pointers/metadata stay stable.',
  'grammar restrictions':'Each section reports source-shape restrictions separately from solver claims. Integer literals admit zero, non-leading-zero decimal, and hexadecimal forms with only the modeled suffixes; nonzero leading-zero nonhex forms reject instead of being interpreted as decimal. Loop summaries require zero initialization, unsigned unit increments, an invariant bound with the exact induction < bound guard, and no writes to induction or other state. The exact monotonic guard enumerates every visited index; open early-return summaries permit only one constant return value so existential loop coverage preserves sequential first-match behavior. Nested loops, input/account-data indexed stores, const writes and const-derived destinations reject. Aggregate identity is a source-shape fact, not a Python-boolean theorem claim.',
  'helper lemmas':'equal_key compares all 32 bytes, read_le decodes the four caller-selected bytes little-endian, and write_le writes four low bytes little-endian; their live solana_min.h bodies must match the audited restricted token forms and are hash-bound in this receipt. C type conversion, usual arithmetic conversion, integer promotions and signed add/sub safety import only the named rules from the hash-bound collection_runtime helper and its adapter parser dependency.',
  'mutant evidence':'Each semantic/undefined-behavior mutant records its rejecting claim and the Z3 SAT model assignments; unsupported Account/data/loop-control writes record grammar rejection and are not reported as semantic counterexamples. UNKNOWN, timeout, spawn and parser failures cannot satisfy expected mutant outcomes.',
  'not established':'select/plan implementations, generated caller, canonical element codecs, effect validation/execution, account-loader truthfulness, LLVM/Clang/SBF preservation, runtime abort behavior, Solana transaction rollback, and other-account rollback.',
  'open input nonmutation':'Account member and indexed memory stores are excluded by grammar. The account-structure field frame claims cover only modeled structure fields. No theorem claims that account-data bytes remain unchanged; byte-store exclusion is reported as grammar.',
  'open objects':'a, out and all input spans are valid; account data backing extent is at least a->size; owner/program/state-key spans are 32 bytes; header is 20 bytes; out is a complete aligned BendCollection object and is disjoint from input/account data.',
  'record caller facts':'Each record input label has its own proved C-bitvector correspondence claim. Successful open gives size=56+capacity*stride with positive stride and length<=capacity. Successful select establishes start<=length, start<=capacity, reserved<=capacity-start and loaded=min(length-start,reserved); record sees the same collection/window, no mutation, and local<loaded. The active C u32 index addition is checked for wrap in bitvector form; the parsed return pointer is compared against its exact C-width address formula, whose mapped u32 factors are widened to u64 before multiplication.',
  'span/BV composition':'Mathematical span/no-wrap queries and bitvector address-exactness queries are checked separately. Their composition to conclude that the parsed source pointer is in range uses the documented source-typed width and caller-range reasoning; that cross-domain composition is a prose-level argument, not a single Z3 query.',
};

type HashMap = Record<string, string>;
type Report = Record<string, any>;

function hashes(): HashMap {
  return Object.fromEntries(inputs.map((file) => [file,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
}

function equalKeys(value: object, expected: string[], label: string) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label + ' exact fields');
}

function plainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hashMap(value: unknown, expectedKeys: string[], label: string): asserts value is HashMap {
  assert(plainObject(value), label + ' must be an object');
  equalKeys(value, expectedKeys, label + ' keys');
  for (const [key, digest] of Object.entries(value)) {
    assert.match(digest, /^[0-9a-f]{64}$/, label + '.' + key + ' must be a SHA-256');
  }
}

function claimList(value: unknown, expected: string[], label: string) {
  assert(Array.isArray(value), label + ' must be an array');
  assert.deepEqual(value.map((claim:any) => claim?.name), expected, label + ' exact names');
  for (const claim of value) {
    equalKeys(claim, ['name', 'result', 'counterexample'], label + ' item');
    assert.equal(claim.result, 'unsat', label + '.' + claim.name + ' must be UNSAT');
    assert.equal(claim.counterexample, null, label + '.' + claim.name + ' cannot carry a counterexample');
  }
}

function validateReport(value: unknown, expectedInputs?: HashMap): asserts value is Report {
  assert(plainObject(value), 'child result must be a JSON object');
  const topKeys = [
    'schema', 'passed', 'z3', 'scope', 'compositionRunId', 'contractInterface', 'contractInterfaceHash',
    'inputs', 'helperImports', 'claimResults', 'open',
    'record', 'commit', 'proofAccounting', 'mutations', 'mutationCases', 'equivalents', 'assumptions',
    'generatedCallerPreconditions', 'status', 'source_hash_comparison',
    'source_hashes_at_start', 'source_hashes_at_end', 'source_hashes_at_publication',
  ];
  equalKeys(value, topKeys, 'receipt top-level');
  assert.equal(value.schema, 6);
  assert.equal(value.passed, true);
  assert.equal(value.status, 'PASS');
  assert.equal(value.source_hash_comparison, 'MATCH');
  assert.equal(value.z3, '5.1.0');
  assert.equal(value.scope, 'actual ABI-3 open plus record/commit under explicit select/plan preconditions');
  assert(value.compositionRunId === null || typeof value.compositionRunId === 'string');
  assert.equal(value.contractInterface?.format, 'bend.collection-helper-contracts/v1');
  assert.match(value.contractInterfaceHash, /^[0-9a-f]{64}$/);
  hashMap(value.inputs, inputs, 'receipt inputs');
  hashMap(value.source_hashes_at_start, inputs, 'source_hashes_at_start');
  hashMap(value.source_hashes_at_end, inputs, 'source_hashes_at_end');
  hashMap(value.source_hashes_at_publication, inputs, 'source_hashes_at_publication');
  assert.deepEqual(value.source_hashes_at_start, value.inputs, 'receipt starting hashes');
  assert.deepEqual(value.source_hashes_at_end, value.inputs, 'receipt ending hashes');
  assert.deepEqual(value.source_hashes_at_publication, value.inputs, 'receipt publication hashes');
  if (expectedInputs) assert.deepEqual(value.inputs, expectedInputs, 'proof inputs differ from parent pre-run hashes');
  hashMap(value.helperImports, helperInputs, 'helperImports');
  for (const file of helperInputs) {
    assert.equal(value.helperImports[file], value.inputs[file], 'helper import ' + file + ' is not hash-bound');
  }

  claimList(value.claimResults, claimNames, 'claimResults');
  assert(plainObject(value.open), 'open receipt section must be an object');
  equalKeys(value.open, ['claims', 'verifiedFacts', 'grammarRestrictions', 'writeTargets',
    'readObligations', 'ubObligations', 'helperCalls', 'returns'],
  'open receipt fields');
  claimList(value.open.claims, openClaims, 'open claims');
  assert(Array.isArray(value.open.verifiedFacts) && value.open.verifiedFacts.length >= 6);
  assert.deepEqual(value.open.grammarRestrictions, expectedGrammarRestrictions.open,
    'open exact grammar restriction inventory and content');
  assert(Array.isArray(value.open.writeTargets) && value.open.writeTargets.length === 1);
  assert(Number.isSafeInteger(value.open.readObligations) && value.open.readObligations > 0);
  assert(Number.isSafeInteger(value.open.ubObligations) && value.open.ubObligations >= 0);
  assert(plainObject(value.open.helperCalls), 'helperCalls must be a structured count map');
  for (const count of Object.values(value.open.helperCalls)) assert(Number.isSafeInteger(count) && count >= 0);
  assert(Number.isSafeInteger(value.open.returns) && value.open.returns > 0);

  assert(plainObject(value.record), 'record receipt section must be an object');
  equalKeys(value.record, ['claims', 'correspondenceApplications', 'pointerFormationObligations', 'byteAccessObligations',
    'grammarRestrictions'],
    'record receipt fields');
  claimList(value.record.claims, recordClaims, 'record claims');
  assert.deepEqual(value.record.correspondenceApplications, recordCorrespondenceApplications,
    'record cached correspondence application inventory and widths');
  assert.equal(value.record.pointerFormationObligations, 2,
    'record exact return pointer-formation count');
  assert.equal(value.record.byteAccessObligations, 0,
    'record baseline has no byte reads beyond the modeled return');
  assert.deepEqual(value.record.grammarRestrictions, expectedGrammarRestrictions.record,
    'record exact grammar restriction inventory and content');

  assert(plainObject(value.commit), 'commit receipt section must be an object');
  equalKeys(value.commit, ['claims', 'copyLoops', 'writeOperations', 'summarySpanObligations',
    'addressObligations', 'pointerFormationObligations', 'byteAccessObligations',
    'directAccessObligations', 'indexEquivalenceObligations', 'localTypes', 'localConversions',
    'grammarRestrictions', 'correspondenceApplications', 'contractPreconditionImports'],
    'commit receipt fields');
  claimList(value.commit.claims, commitClaims, 'commit claims');
  assert.deepEqual(value.commit.correspondenceApplications, commitCorrespondenceApplications,
    'commit cached correspondence application inventory and widths');
  const precondition = value.contractInterface.contracts.commit.precondition.args;
  const bindings = value.contractInterface.contracts.commit.preconditionImports;
  assert.equal(bindings.length, precondition.length, 'exact commit precondition import count');
  assert.deepEqual(value.commit.contractPreconditionImports, precondition.map((formula:any,index:number)=>({
    contractFormula:formula,source:bindings[index].source,sourceClaims:bindings[index].claims,
    disposition:'CHECKED_BY_FRESH_COMPOSITION_PARENT',
  })), 'every shared commit precondition has its exact scoped import');
  assert.equal(value.commit.copyLoops, 3, 'commit exact counted-copy loop count');
  assert.equal(value.commit.writeOperations, 4, 'commit exact write-operation count');
  assert.equal(value.commit.summarySpanObligations, 7, 'commit exact summarized span check count');
  assert.equal(value.commit.addressObligations, 7, 'commit exact address no-wrap condition count');
  assert.equal(value.commit.pointerFormationObligations, 7,
    'commit exact parsed pointer-formation count');
  assert.equal(value.commit.byteAccessObligations, 7,
    'commit exact actual byte-read/write span count');
  assert.equal(value.commit.directAccessObligations, 0,
    'commit exact separately analyzed scalar/helper byte-access count');
  assert.equal(value.commit.indexEquivalenceObligations, 6, 'commit parsed-index equivalence count');
  assert(plainObject(value.commit.localTypes), 'commit local type environment');
  assert.equal(value.commit.localTypes.data, 'u8*');
  assert.equal(value.commit.localTypes.offset, 'u64');
  assert(Array.isArray(value.commit.localConversions));
  assert.deepEqual(value.commit.grammarRestrictions, expectedGrammarRestrictions.commit,
    'commit exact grammar restriction inventory and content');
  assert(value.commit.localConversions.some((item:any) => item?.name === 'offset'
    && item.operation === 'initialize' && item.destinationType === 'u64'),
  'commit receipt must bind offset initializer to declared u64');

  assert(plainObject(value.proofAccounting), 'proof accounting must be an object');
  equalKeys(value.proofAccounting, ['claimResultEntries', 'independentRuntimeProofObligations',
    'cachedGenericCorrespondenceLemmas', 'correspondenceApplications',
    'genericArithmeticRegressionLemmas', 'grammarRestrictions'], 'proof accounting fields');
  assert.equal(value.proofAccounting.claimResultEntries, claimNames.length,
    'proof accounting raw result entry count');
  assert.deepEqual(value.proofAccounting.independentRuntimeProofObligations, {
    count:independentRuntimeClaimNames.length, claims:independentRuntimeClaimNames,
  }, 'independent runtime proof obligation inventory');
  assert.deepEqual(value.proofAccounting.cachedGenericCorrespondenceLemmas, [
    {name:'unsigned Int2BV inverse',width:32,result:'unsat',solverQueries:1},
    {name:'unsigned Int2BV inverse',width:64,result:'unsat',solverQueries:1},
  ], 'one cached UNSAT correspondence lemma per supported input width');
  assert.deepEqual(value.proofAccounting.correspondenceApplications, correspondenceApplications,
    'cached correspondence lemma applications');
  assert.deepEqual(value.proofAccounting.genericArithmeticRegressionLemmas,
    genericArithmeticRegressionNames.map((name) => ({name,result:'unsat'})),
    'source-independent generic arithmetic regression lemmas');
  assert.deepEqual(value.proofAccounting.grammarRestrictions, {
    count:18,
    sourceShapeOnly:true,
    scope:'Restrictions are reported in open, record and commit sections; they are parser/source-shape limits, not SMT proof obligations.',
  }, 'grammar restrictions are accounted separately from SMT obligations');

  assert.deepEqual(value.mutationCases, mutationCases.map(([name, kind]) => ({name, kind})),
    'exact permanent mutation case inventory');
  assert(Array.isArray(value.mutations), 'mutations must be an array');
  assert.deepEqual(value.mutations.map((item:any) => item?.name),
    mutationCases.map(([name]) => name), 'exact mutation result inventory');
  value.mutations.forEach((item:any, index:number) => {
    const [name, expectedKind] = mutationCases[index];
    assert.equal(item.kind, expectedKind, name + ' exact rejection class');
    if (expectedKind === 'grammar') {
      equalKeys(item, ['name', 'kind', 'expected', 'reason'], name + ' result');
      assert.equal(item.expected, 'grammar');
      assert.match(item.reason, /unsupported|restriction|induction variable|invariant|scalar operands/i);
      if (name.includes('octal integer literal')) {
        assert.match(item.reason, /literal: unsupported leading-zero nonhex integer literal/,
          name + ' must reject for literal semantics, not inventory shape');
      }
    } else {
      equalKeys(item, ['name', 'kind', 'obligation', 'counterexample'], name + ' result');
      assert.equal(item.counterexample?.solver, 'sat', name + ' must carry a solver SAT witness');
      assert(plainObject(item.counterexample.input) && Object.keys(item.counterexample.input).length > 0,
        name + ' must carry solver-derived input assignments');
      for (const field of Object.values(item.counterexample.input)) {
        assert.equal(typeof field, 'string', name + ' witness values must be serialized solver values');
      }
      assert.equal(typeof item.obligation, 'string');
      assert(item.obligation.length > 0);
    }
  });

  assert(Array.isArray(value.equivalents), 'equivalents must be an array');
  assert.deepEqual(value.equivalents.map((item:any) => item?.name), equivalentNames,
    'exact equivalent rewrite inventory');
  for (const item of value.equivalents) {
    equalKeys(item, ['name', 'result', 'failed'], item.name + ' equivalent');
    assert.equal(item.result, 'unsat', item.name + ' must re-prove');
    assert.deepEqual(item.failed, [], item.name + ' failed claim list');
  }
  assert.deepEqual(value.assumptions, expectedAssumptions,
    'assumption inventory and exact content, including the prose-level span/BV composition caveat');
  assert(Array.isArray(value.generatedCallerPreconditions) && value.generatedCallerPreconditions.length >= 6);
}

function uniqueEvidencePath(file: string, disposition: string) {
  return path.join(root, file + '.' + disposition + '.' + Date.now() + '.' + process.pid + '.' + randomUUID());
}

function quarantine(file: string, disposition: 'previous' | 'unaccepted'): string | undefined {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) return undefined;
  const before = fs.readFileSync(full);
  const safe = uniqueEvidencePath(file, disposition);
  fs.renameSync(full, safe);
  assert.equal(fs.existsSync(full), false, file + ' remained canonical after quarantine');
  assert.deepEqual(fs.readFileSync(safe), before, file + ' changed while being quarantined');
  return path.relative(root, safe);
}

function atomicArchive(safeRelative: string): string | undefined {
  const safe = path.join(root, safeRelative);
  const bytes = fs.readFileSync(safe);
  try {
    validateReport(JSON.parse(bytes.toString('utf8')));
  } catch {
    return undefined;
  }
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const directory = path.join(root, 'build/refinement-reports');
  fs.mkdirSync(directory, {recursive:true});
  const archived = path.join(directory, digest + '.json');
  if (fs.existsSync(archived)) {
    assert.deepEqual(fs.readFileSync(archived), bytes, 'existing content-addressed archive differs');
  } else {
    const tmp = archived + '.tmp.' + process.pid + '.' + randomUUID();
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(tmp, archived);
    } catch (error:any) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      assert.deepEqual(fs.readFileSync(archived), bytes, 'archive race produced conflicting bytes');
    } finally {
      fs.rmSync(tmp, {force:true});
    }
  }
  assert.deepEqual(fs.readFileSync(archived), bytes, 'archived bytes failed exact verification');
  const dirFd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  fs.rmSync(safe);
  return path.relative(root, archived);
}

function archivePriorReceipt(): {archived: string[]; preserved: string[]} {
  const archived: string[] = [];
  const preserved: string[] = [];
  for (const file of [receipt, pending, pendingTmp, publishTmp]) {
    const safe = quarantine(file, 'previous');
    if (!safe) continue;
    if (file === receipt) {
      try {
        const destination = atomicArchive(safe);
        if (destination) archived.push(destination);
        else preserved.push(safe);
      } catch (error) {
        throw new Error('could not archive prior receipt; canonical success path is clear and evidence is preserved at '
          + safe + ': ' + String(error));
      }
    } else {
      preserved.push(safe);
    }
  }
  return {archived, preserved};
}

function preserveFreshArtifacts(): string[] {
  const preserved: string[] = [];
  for (const file of [pending, pendingTmp, publishTmp, receipt]) {
    const safe = quarantine(file, 'unaccepted');
    if (safe) preserved.push(safe);
  }
  return preserved;
}

function childFailure(result: ReturnType<typeof spawnSync>, expectedStatus: number): string | undefined {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code ?? 'unknown';
    return 'spawn/buffer/timeout failure (' + code + '): ' + result.error.message;
  }
  if (result.signal) return 'child terminated by signal ' + result.signal;
  if (result.status !== expectedStatus) return 'child exited ' + result.status;
  return undefined;
}

function runChild(args: string[], expectedStatus = 0) {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(python, ['-B', 'verification/collection_lifecycle.py', ...args], {
      cwd: root, encoding: 'utf8', timeout: 600_000, maxBuffer: 1 << 24,
    });
  } catch (error) {
    const evidence = preserveFreshArtifacts();
    throw new Error('proof child spawn threw: ' + String(error) + '; preserved=' + JSON.stringify(evidence));
  }
  const failure = childFailure(result, expectedStatus);
  if (failure) {
    const evidence = preserveFreshArtifacts();
    const diagnostic = (result.stderr || '') + (result.stdout || '');
    throw new Error('proof child ' + failure + '; ' + diagnostic.trim()
      + '; preserved=' + JSON.stringify(evidence));
  }
  return result;
}

function verifyNegativeProbe(stdout: string) {
  const lines = stdout.trim().split('\n');
  const result = JSON.parse(lines.at(-1) ?? '{}');
  assert.equal(result.negative, true);
  assert.equal(result.obligation, 'open exact ordered error/success contract');
  assert.equal(result.counterexample?.solver, 'sat');
  assert(plainObject(result.counterexample?.input) && Object.keys(result.counterexample.input).length > 0);
  assert.equal(result.counterexample.input.json_newline_probe, 'first\nsecond',
    'escaped newline inside JSON model output must remain inside one JSON record');
  assert.equal(fs.existsSync(path.join(root, pending)), false, 'negative probe left pending output');
  assert.equal(fs.existsSync(path.join(root, receipt)), false, 'negative probe left canonical success receipt');
}

function publishAtomically(bytes: Buffer) {
  const tmp = path.join(root, publishTmp);
  const destination = path.join(root, receipt);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  assert.deepEqual(fs.readFileSync(tmp), bytes, 'temporary publication differs from validated child output');
  fs.linkSync(tmp, destination);
  fs.rmSync(tmp);
  assert.deepEqual(fs.readFileSync(destination), bytes, 'published receipt differs from validated child output');
  const dirFd = fs.openSync(path.dirname(destination), 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  fs.rmSync(path.join(root, pending));
}

const archived: string[] = [];
const preservedPrevious: string[] = [];
try {
  const prior = archivePriorReceipt();
  archived.push(...prior.archived);
  preservedPrevious.push(...prior.preserved);
  const before = hashes();

  const negative = runChild(['--negative-probe'], 23);
  verifyNegativeProbe(negative.stdout || '');
  assert.deepEqual(hashes(), before, 'negative probe changed bound source inputs');

  runChild([]);
  assert(fs.existsSync(path.join(root, pending)), 'proof child did not produce pending output');
  const pendingBytes = fs.readFileSync(path.join(root, pending));
  const report = JSON.parse(pendingBytes.toString('utf8'));
  validateReport(report, before);
  assert.deepEqual(hashes(), before, 'runtime, helper or checker source changed while proving');
  publishAtomically(pendingBytes);
  const finalBytes = fs.readFileSync(path.join(root, receipt));
  assert.deepEqual(finalBytes, pendingBytes, 'canonical receipt changed after atomic publication');
  validateReport(JSON.parse(finalBytes.toString('utf8')), hashes());
  process.stdout.write(JSON.stringify({
    passed: true,
    independentRuntimeProofObligations: report.proofAccounting.independentRuntimeProofObligations.count,
    cachedGenericCorrespondenceLemmas: report.proofAccounting.cachedGenericCorrespondenceLemmas.length,
    correspondenceApplications: report.proofAccounting.correspondenceApplications.length,
    genericArithmeticRegressionLemmas: report.proofAccounting.genericArithmeticRegressionLemmas.length,
    grammarRestrictionEntries: report.proofAccounting.grammarRestrictions.count,
    claimResultEntries: report.proofAccounting.claimResultEntries,
    mutations: mutationCases.length,
    semanticMutants: mutationCases.filter(([, kind]) => kind === 'semantic').length,
    undefinedBehaviorMutants: mutationCases.filter(([, kind]) => kind === 'undefined_behavior').length,
    grammarRejections: mutationCases.filter(([, kind]) => kind === 'grammar').length,
    equivalents: equivalentNames.length,
    archived,
    preservedPrevious,
    receipt,
    z3: report.z3,
  }) + '\n');
} catch (error) {
  const evidence = preserveFreshArtifacts();
  process.stderr.write(String(error) + '; fresh failed output preserved='
    + JSON.stringify(evidence) + '; prior evidence=' + JSON.stringify(preservedPrevious) + '\n');
  process.exitCode = 1;
}
