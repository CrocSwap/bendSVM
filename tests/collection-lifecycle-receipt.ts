import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.PYTHON ?? 'python3';
const files = [
  'runtime/bend_collection_runtime.h',
  'runtime/solana_min.h',
  'verification/collection_lifecycle.py',
  'verification/check-collection-lifecycle.ts',
  'verification/collection_runtime.py',
  'verification/adapter_contract_c.py',
  'verification/collection_contracts.py',
];
const receipt = 'build/collection-lifecycle-refinement.json';
const pending = receipt + '.pending';
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
const mutations = [
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
const equivalents = [
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
const grammarRestrictions = {
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
const assumptions = {
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

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-lifecycle-receipt-'));
  for (const relative of files) {
    const destination = path.join(root, relative);
    fs.mkdirSync(dirname(destination), {recursive:true});
    fs.copyFileSync(path.join(repoRoot, relative), destination);
  }
  fs.mkdirSync(path.join(root, 'build'), {recursive:true});
  return root;
}

function sourceHashes(root: string) {
  return Object.fromEntries(files.map((file) => [file,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
}

function unsat(names: string[]) {
  return names.map((name) => ({name, result:'unsat', counterexample:null}));
}

function validReport(root: string) {
  const inputs = sourceHashes(root);
  const allClaims = claimNames;
  const helperImports = Object.fromEntries(files.slice(4).map((file) => [file, inputs[file]]));
  const preconditionFormulas = Array.from({length:13}, (_value,index) => ({fixtureClause:index}));
  const preconditionBindings = [
    ['open',['open exact ordered error/success contract']],
    ['open',['open unsigned division/remainder yields exact capacity payload relation']],
    ['open',['open exact ordered error/success contract','success writes exact collection fields']],
    ['select',['select: exact return and output contract','select: start is within old logical length']],
    ['select',['select: reserved end is within capacity']],
    ['select',['select: exact start/reserved/loaded outputs on success']],
    ['plan',['plan: loaded prefix is retained by count']],
    ['plan',['plan: written record count fits selected reservation']],
    ['plan',['plan: exact return and output contract']],
    ['plan',['plan: next logical length is bounded']],
    ['plan',['plan: appends extend exactly from old tail']],
    ['plan',['plan: additions equal logical length growth']],
    ['composition',['eight-byte record scratch covers written times four-byte stride']],
  ].map(([source,claims])=>({source,claims}));
  const contractPreconditionImports = preconditionFormulas.map((contractFormula,index)=>({
    contractFormula,source:preconditionBindings[index].source,
    sourceClaims:preconditionBindings[index].claims,
    disposition:'CHECKED_BY_FRESH_COMPOSITION_PARENT',
  }));
  return {
    schema:6,
    passed:true,
    z3:'5.1.0',
    scope:'actual ABI-3 open plus record/commit under explicit select/plan preconditions',
    compositionRunId:null,
    contractInterface:{format:'bend.collection-helper-contracts/v1',contracts:{commit:{
      precondition:{args:preconditionFormulas},preconditionImports:preconditionBindings,
    }}},
    contractInterfaceHash:'0'.repeat(64),
    inputs,
    helperImports,
    claimResults:unsat(allClaims),
    proofAccounting:{
      claimResultEntries:allClaims.length,
      independentRuntimeProofObligations:{
        count:independentRuntimeClaimNames.length,claims:independentRuntimeClaimNames,
      },
      cachedGenericCorrespondenceLemmas:[
        {name:'unsigned Int2BV inverse',width:32,result:'unsat',solverQueries:1},
        {name:'unsigned Int2BV inverse',width:64,result:'unsat',solverQueries:1},
      ],
      correspondenceApplications,
      genericArithmeticRegressionLemmas:genericArithmeticRegressionNames
        .map((name) => ({name,result:'unsat'})),
      grammarRestrictions:{
        count:18,
        sourceShapeOnly:true,
        scope:'Restrictions are reported in open, record and commit sections; they are parser/source-shape limits, not SMT proof obligations.',
      },
    },
    open:{
      claims:unsat(openClaims),
      verifiedFacts:['a','b','c','d','e','f'],
      grammarRestrictions:grammarRestrictions.open,
      writeTargets:['BendCollection output'],
      readObligations:1,
      ubObligations:0,
      helperCalls:{},
      returns:4,
    },
    record:{claims:unsat(recordClaims),correspondenceApplications:recordCorrespondenceApplications,
      pointerFormationObligations:2,byteAccessObligations:0,
      grammarRestrictions:grammarRestrictions.record},
    commit:{
      claims:unsat(commitClaims),
      copyLoops:3,
      writeOperations:4,
      summarySpanObligations:7,
      addressObligations:7,
      pointerFormationObligations:7,
      byteAccessObligations:7,
      directAccessObligations:0,
      indexEquivalenceObligations:6,
      localTypes:{data:'u8*',offset:'u64'},
      localConversions:[{name:'offset',operation:'initialize',sourceType:'u64',destinationType:'u64'}],
      grammarRestrictions:grammarRestrictions.commit,
      correspondenceApplications:commitCorrespondenceApplications,
      contractPreconditionImports,
    },
    mutations:mutations.map(([name, kind]) => kind === 'grammar'
      ? {name,kind,expected:'grammar',reason:name.includes('octal integer literal')
        ? 'literal: unsupported leading-zero nonhex integer literal 010'
        : 'unsupported input write under a grammar restriction'}
      : {name,kind,obligation:'synthetic structured probe',
        counterexample:{solver:'sat',input:{synthetic_solver_variable:'1'}}}),
    mutationCases:mutations.map(([name, kind]) => ({name,kind})),
    equivalents:equivalents.map((name) => ({name,result:'unsat',failed:[]})),
    assumptions,
    generatedCallerPreconditions:['a','b','c','d','e','f'],
    status:'PASS',
    source_hash_comparison:'MATCH',
    source_hashes_at_start:inputs,
    source_hashes_at_end:inputs,
    source_hashes_at_publication:inputs,
  };
}

function writeWrapper(root: string) {
  const wrapper = path.join(root, 'build/fake-python.py');
  const lines = [
    '#!/usr/bin/env python3',
    'import base64, json, os, pathlib, subprocess, sys',
    'args = sys.argv[1:]',
    'if "--negative-probe" in args:',
    '    print("{\\"negative\\":true,\\"obligation\\":\\"open exact ordered error/success contract\\",\\"counterexample\\":{\\"solver\\":\\"sat\\",\\"input\\":{\\"synthetic_solver_variable\\":\\"1\\",\\"json_newline_probe\\":\\"first\\\\nsecond\\"}}}")',
    '    raise SystemExit(23)',
    'mode = os.environ.get("COLLECTION_LIFECYCLE_RECEIPT_MODE", "success")',
    'if mode == "unknown":',
    '    result = subprocess.run([os.environ["COLLECTION_LIFECYCLE_REAL_PYTHON"], *args, "--unknown-probe"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)',
    '    sys.stdout.buffer.write(result.stdout)',
    '    sys.stderr.buffer.write(result.stderr)',
    '    raise SystemExit(result.returncode)',
    'raw = base64.b64decode(os.environ["COLLECTION_LIFECYCLE_RECEIPT_B64"])',
    'if mode in ("success", "published-nonzero", "source-drift", "malformed", "forged", "negative-open-restriction-missing", "negative-record-restriction-replaced", "negative-commit-restriction-extra", "negative-assumption-missing", "negative-assumption-replaced", "negative-assumption-counterfeit", "negative-generic-octal-reason"): ',
    '    pathlib.Path("build/collection-lifecycle-refinement.json.pending").write_bytes(raw)',
    'if mode.startswith("negative-"):',
    '    report = json.loads(raw)',
    '    if mode == "negative-open-restriction-missing": report["open"]["grammarRestrictions"].pop(); report["proofAccounting"]["grammarRestrictions"]["count"] = 17',
    '    if mode == "negative-record-restriction-replaced": report["record"]["grammarRestrictions"][1] = "synthetic placeholder restriction"',
    '    if mode == "negative-commit-restriction-extra": report["commit"]["grammarRestrictions"].append("synthetic extra restriction"); report["proofAccounting"]["grammarRestrictions"]["count"] = 19',
    '    if mode == "negative-assumption-missing": del report["assumptions"]["span/BV composition"]',
    '    if mode == "negative-assumption-replaced": report["assumptions"]["span/BV composition"] = "the checker proves the composition in one Z3 query"',
    '    if mode == "negative-assumption-counterfeit": report["assumptions"]["purported proof"] = "the composition is solver-proved"',
    '    if mode == "negative-generic-octal-reason":\n        [item.update(reason="unsupported input write under a grammar restriction") for item in report["mutations"] if "octal integer literal" in item["name"]]',
    '    pathlib.Path("build/collection-lifecycle-refinement.json.pending").write_text(json.dumps(report, indent=2) + "\\n")',
    'if mode == "source-drift":',
    '    target = pathlib.Path("runtime/bend_collection_runtime.h")',
    '    target.write_bytes(target.read_bytes() + b"\\\\n/* source drift regression */\\\\n")',
    'if mode == "malformed":',
    '    pathlib.Path("build/collection-lifecycle-refinement.json.pending").write_text("{\\"passed\\":true}\\n")',
    'if mode == "forged":',
    '    pathlib.Path("build/collection-lifecycle-refinement.json.pending").write_text("{\\"passed\\":true,\\"claims\\":[{\\"result\\":\\"unsat\\"}]}\\n")',
    'if mode == "published-nonzero":',
    '    raise SystemExit(29)',
    'raise SystemExit(0)',
    '',
  ];
  fs.writeFileSync(wrapper, lines.join('\n'), {mode:0o755});
  return wrapper;
}

function runDriver(root: string, mode: string, bytes: Buffer) {
  const wrapper = writeWrapper(root);
  return spawnSync(process.execPath, [path.join(root, 'verification/check-collection-lifecycle.ts')], {
    cwd:root,
    encoding:'utf8',
    env:{
      ...process.env,
      PYTHON:wrapper,
      COLLECTION_LIFECYCLE_RECEIPT_MODE:mode,
      COLLECTION_LIFECYCLE_RECEIPT_B64:bytes.toString('base64'),
      COLLECTION_LIFECYCLE_REAL_PYTHON:python,
    },
    timeout:30_000,
    maxBuffer:16 * 1024 * 1024,
  });
}

function evidenceFiles(root: string, prefix: string) {
  const namePrefix = path.basename(prefix);
  return fs.readdirSync(path.join(root, 'build')).filter((name) => name.startsWith(namePrefix))
    .map((name) => path.join(root, 'build', name));
}

function assertArchived(root: string, bytes: Buffer) {
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const file = path.join(root, 'build/refinement-reports', digest + '.json');
  assert.deepEqual(fs.readFileSync(file), bytes, 'previous receipt archive bytes');
}

function runFailureCase(bytes: Buffer, mode: string, expected: RegExp, expectsFresh: boolean) {
  const root = makeFixture();
  try {
    fs.writeFileSync(path.join(root, receipt), bytes);
    const result = runDriver(root, mode, bytes);
    const diagnostic = (result.stdout || '') + (result.stderr || '');
    assert.notEqual(result.status, 0, mode + ' should fail closed');
    assert.match(diagnostic, expected);
    assert.equal(fs.existsSync(path.join(root, receipt)), false, mode + ' left canonical receipt');
    assertArchived(root, bytes);
    const fresh = evidenceFiles(root, pending + '.unaccepted.');
    if (expectsFresh) {
      assert.equal(fresh.length, 1, mode + ' fresh bytes must be quarantined');
      if (mode === 'published-nonzero') assert.deepEqual(fs.readFileSync(fresh[0]), bytes);
      if (mode === 'source-drift') assert.deepEqual(fs.readFileSync(fresh[0]), bytes);
      if (mode === 'malformed') assert.deepEqual(fs.readFileSync(fresh[0]), Buffer.from('{"passed":true}\n'));
      if (mode === 'forged') assert.deepEqual(fs.readFileSync(fresh[0]),
        Buffer.from('{"passed":true,"claims":[{"result":"unsat"}]}\n'));
      if (mode.startsWith('negative-')) {
        const forged = JSON.parse(fs.readFileSync(fresh[0], 'utf8'));
        if (mode === 'negative-open-restriction-missing') assert.equal(forged.open.grammarRestrictions.length, 4);
        if (mode === 'negative-record-restriction-replaced') {
          assert.equal(forged.record.grammarRestrictions[1], 'synthetic placeholder restriction');
        }
        if (mode === 'negative-commit-restriction-extra') assert.equal(forged.commit.grammarRestrictions.length, 11);
        if (mode === 'negative-assumption-missing') assert.equal('span/BV composition' in forged.assumptions, false);
        if (mode === 'negative-assumption-replaced') {
          assert.equal(forged.assumptions['span/BV composition'], 'the checker proves the composition in one Z3 query');
        }
        if (mode === 'negative-assumption-counterfeit') assert.equal('purported proof' in forged.assumptions, true);
        if (mode === 'negative-generic-octal-reason') {
          const octal = forged.mutations.filter((item:any) => item.name.includes('octal integer literal'));
          assert.equal(octal.length, 2);
          assert(octal.every((item:any) => item.kind === 'grammar'
            && item.reason === 'unsupported input write under a grammar restriction'));
        }
      }
    } else {
      assert.deepEqual(fresh, [], mode + ' unexpectedly produced child evidence');
    }
  } finally {
    fs.rmSync(root, {recursive:true, force:true});
  }
}

function caseArchiveConflict(bytes: Buffer) {
  const root = makeFixture();
  try {
    fs.writeFileSync(path.join(root, receipt), bytes);
    fs.writeFileSync(path.join(root, 'build/refinement-reports'), 'block archive directory');
    const result = runDriver(root, 'success', bytes);
    const diagnostic = (result.stdout || '') + (result.stderr || '');
    assert.notEqual(result.status, 0);
    assert.match(diagnostic, /could not archive prior receipt/);
    assert.equal(fs.existsSync(path.join(root, receipt)), false);
    const safe = evidenceFiles(root, receipt + '.previous.');
    assert.equal(safe.length, 1, 'old bytes must be renamed out before archive');
    assert.deepEqual(fs.readFileSync(safe[0]), bytes);
    assert(diagnostic.includes(path.basename(safe[0])), 'archive diagnostic must name preserved evidence');
  } finally {
    fs.rmSync(root, {recursive:true, force:true});
  }
}

function caseSuccessfulPublication(bytes: Buffer) {
  const root = makeFixture();
  try {
    fs.writeFileSync(path.join(root, receipt), bytes);
    const result = runDriver(root, 'success', bytes);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assertArchived(root, bytes);
    assert.deepEqual(fs.readFileSync(path.join(root, receipt)), bytes);
    assert.deepEqual(evidenceFiles(root, pending + '.unaccepted.'), []);
  } finally {
    fs.rmSync(root, {recursive:true, force:true});
  }
}

function runNativePair(name: string, source: string,
    oldText: string | Array<{oldText:string;newText:string}>, newText: string | undefined,
    baselineOutput: RegExp, mutantOutput: RegExp) {
  const runId = Date.now() + '-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  const evidenceRoot = path.join(repoRoot, 'build/collection-lifecycle-native-evidence', name, runId);
  const baselineDir = path.join(evidenceRoot, 'baseline/include');
  const mutantDir = path.join(evidenceRoot, 'mutant/include');
  fs.mkdirSync(baselineDir, {recursive:true});
  fs.mkdirSync(mutantDir, {recursive:true});
  fs.writeFileSync(path.join(evidenceRoot, 'witness.c'), source);
  for (const includeDir of [baselineDir, mutantDir]) {
    fs.copyFileSync(path.join(repoRoot, 'runtime/bend_collection_runtime.h'),
      path.join(includeDir, 'bend_collection_runtime.h'));
    fs.copyFileSync(path.join(repoRoot, 'runtime/solana_min.h'),
      path.join(includeDir, 'solana_min.h'));
  }
  const mutatedHeader = path.join(mutantDir, 'bend_collection_runtime.h');
  const original = fs.readFileSync(mutatedHeader, 'utf8');
  let mutated = original;
  const replacements = Array.isArray(oldText) ? oldText : [{oldText, newText:newText ?? ''}];
  for (const replacement of replacements) {
    assert.equal(mutated.split(replacement.oldText).length - 1, 1,
      name + ' mutation target must be unique: ' + replacement.oldText);
    mutated = mutated.replace(replacement.oldText, replacement.newText);
  }
  fs.writeFileSync(mutatedHeader, mutated);

  const compiler = process.env.CC ?? 'clang';
  for (const [label, includeDir, expected] of [
    ['baseline', baselineDir, baselineOutput],
    ['mutant', mutantDir, mutantOutput],
  ] as const) {
    const executable = path.join(evidenceRoot, label + '.bin');
    const compile = spawnSync(compiler, ['-std=c17', '-O1', '-Wall', '-Wextra', '-Werror',
      '-I', includeDir, path.join(evidenceRoot, 'witness.c'), '-o', executable], {
      cwd:evidenceRoot, encoding:'utf8', timeout:30_000,
    });
    fs.writeFileSync(path.join(evidenceRoot, label + '.compile.log'), JSON.stringify({
      command:[compiler, '-std=c17', '-O1', '-Wall', '-Wextra', '-Werror', '-I', includeDir,
        path.join(evidenceRoot, 'witness.c'), '-o', executable],
      status:compile.status, signal:compile.signal, error:compile.error?.message,
      stdout:compile.stdout, stderr:compile.stderr,
    }, null, 2) + '\n');
    assert.ifError(compile.error);
    assert.equal(compile.status, 0, name + ' ' + label + ' compile failed; evidence=' + evidenceRoot);
    const run = spawnSync(executable, [], {cwd:evidenceRoot, encoding:'utf8', timeout:30_000});
    fs.writeFileSync(path.join(evidenceRoot, label + '.run.log'), JSON.stringify({
      status:run.status, signal:run.signal, error:run.error?.message,
      stdout:run.stdout, stderr:run.stderr,
    }, null, 2) + '\n');
    assert.ifError(run.error);
    assert.equal(run.status, 0, name + ' ' + label + ' native run failed; evidence=' + evidenceRoot);
    assert.match(run.stdout, expected, name + ' ' + label + ' output; evidence=' + evidenceRoot);
  }
  return evidenceRoot;
}

function runNativeFaultPair(name: string, source: string, oldText: string, newText: string,
    baselineOutput: RegExp) {
  const runId = Date.now() + '-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  const evidenceRoot = path.join(repoRoot, 'build/collection-lifecycle-native-evidence', name, runId);
  const baselineDir = path.join(evidenceRoot, 'baseline/include');
  const mutantDir = path.join(evidenceRoot, 'mutant/include');
  fs.mkdirSync(baselineDir, {recursive:true});
  fs.mkdirSync(mutantDir, {recursive:true});
  fs.writeFileSync(path.join(evidenceRoot, 'witness.c'), source);
  for (const includeDir of [baselineDir, mutantDir]) {
    fs.copyFileSync(path.join(repoRoot, 'runtime/bend_collection_runtime.h'),
      path.join(includeDir, 'bend_collection_runtime.h'));
    fs.copyFileSync(path.join(repoRoot, 'runtime/solana_min.h'),
      path.join(includeDir, 'solana_min.h'));
  }
  const mutatedHeader = path.join(mutantDir, 'bend_collection_runtime.h');
  const original = fs.readFileSync(mutatedHeader, 'utf8');
  assert.equal(original.split(oldText).length - 1, 1, name + ' mutation target must be unique');
  fs.writeFileSync(mutatedHeader, original.replace(oldText, newText));

  const compiler = process.env.CC ?? 'clang';
  for (const [label, includeDir] of [['baseline', baselineDir], ['mutant', mutantDir]] as const) {
    const executable = path.join(evidenceRoot, label + '.bin');
    const compile = spawnSync(compiler, ['-std=c17', '-O0', '-Wall', '-Wextra', '-Werror',
      '-I', includeDir, path.join(evidenceRoot, 'witness.c'), '-o', executable], {
      cwd:evidenceRoot, encoding:'utf8', timeout:30_000,
    });
    fs.writeFileSync(path.join(evidenceRoot, label + '.compile.log'), JSON.stringify({
      command:[compiler, '-std=c17', '-O0', '-Wall', '-Wextra', '-Werror', '-I', includeDir,
        path.join(evidenceRoot, 'witness.c'), '-o', executable],
      status:compile.status, signal:compile.signal, error:compile.error?.message,
      stdout:compile.stdout, stderr:compile.stderr,
    }, null, 2) + '\n');
    assert.ifError(compile.error);
    assert.equal(compile.status, 0, name + ' ' + label + ' compile failed; evidence=' + evidenceRoot);
    const run = spawnSync(executable, [], {cwd:evidenceRoot, encoding:'utf8', timeout:30_000});
    fs.writeFileSync(path.join(evidenceRoot, label + '.run.log'), JSON.stringify({
      status:run.status, signal:run.signal, error:run.error?.message,
      stdout:run.stdout, stderr:run.stderr,
    }, null, 2) + '\n');
    assert.ifError(run.error);
    if (label === 'baseline') {
      assert.equal(run.status, 0, name + ' baseline run failed; evidence=' + evidenceRoot);
      assert.match(run.stdout, baselineOutput, name + ' baseline output; evidence=' + evidenceRoot);
    } else {
      assert.equal(run.status, 0, name + ' mutant signal handler failed; evidence=' + evidenceRoot);
      assert.match(run.stdout, /guard_page_fault=SIG(?:BUS|SEGV)\n/,
        name + ' mutant must catch a PROT_NONE guard-page fault; evidence=' + evidenceRoot);
    }
  }
  return evidenceRoot;
}

function runNativeTimeoutPair(name: string, source: string, oldText: string, newText: string) {
  const runId = Date.now() + '-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  const evidenceRoot = path.join(repoRoot, 'build/collection-lifecycle-native-evidence', name, runId);
  const baselineDir = path.join(evidenceRoot, 'baseline/include');
  const mutantDir = path.join(evidenceRoot, 'mutant/include');
  fs.mkdirSync(baselineDir, {recursive:true});
  fs.mkdirSync(mutantDir, {recursive:true});
  fs.writeFileSync(path.join(evidenceRoot, 'witness.c'), source);
  for (const includeDir of [baselineDir, mutantDir]) {
    fs.copyFileSync(path.join(repoRoot, 'runtime/bend_collection_runtime.h'),
      path.join(includeDir, 'bend_collection_runtime.h'));
    fs.copyFileSync(path.join(repoRoot, 'runtime/solana_min.h'),
      path.join(includeDir, 'solana_min.h'));
  }
  const mutatedHeader = path.join(mutantDir, 'bend_collection_runtime.h');
  const original = fs.readFileSync(mutatedHeader, 'utf8');
  assert.equal(original.split(oldText).length - 1, 1, name + ' mutation target must be unique');
  fs.writeFileSync(mutatedHeader, original.replace(oldText, newText));
  const compiler = process.env.CC ?? 'clang';
  for (const [label, includeDir] of [['baseline', baselineDir], ['mutant', mutantDir]] as const) {
    const executable = path.join(evidenceRoot, label + '.bin');
    const compile = spawnSync(compiler, ['-std=c17', '-O1', '-Wall', '-Wextra', '-Werror',
      '-I', includeDir, path.join(evidenceRoot, 'witness.c'), '-o', executable], {
      cwd:evidenceRoot, encoding:'utf8', timeout:30_000,
    });
    fs.writeFileSync(path.join(evidenceRoot, label + '.compile.log'), JSON.stringify({
      command:[compiler, '-std=c17', '-O1', '-Wall', '-Wextra', '-Werror', '-I', includeDir,
        path.join(evidenceRoot, 'witness.c'), '-o', executable],
      status:compile.status, signal:compile.signal, error:compile.error?.message,
      stdout:compile.stdout, stderr:compile.stderr,
    }, null, 2) + '\n');
    assert.ifError(compile.error);
    assert.equal(compile.status, 0, name + ' ' + label + ' compile failed; evidence=' + evidenceRoot);
    const run = spawnSync(executable, [], {
      cwd:evidenceRoot, encoding:'utf8', timeout:label === 'baseline' ? 5_000 : 1_000,
    });
    fs.writeFileSync(path.join(evidenceRoot, label + '.run.log'), JSON.stringify({
      status:run.status, signal:run.signal, error:run.error?.message,
      errorCode:(run.error as NodeJS.ErrnoException | undefined)?.code,
      stdout:run.stdout, stderr:run.stderr,
    }, null, 2) + '\n');
    if (label === 'baseline') {
      assert.ifError(run.error);
      assert.equal(run.status, 0, name + ' baseline run failed; evidence=' + evidenceRoot);
      assert.match(run.stdout, /open_rc=0\n/);
    } else {
      assert.equal((run.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT',
        name + ' mutant must exhibit the preserved zero-scan nontermination; evidence=' + evidenceRoot);
    }
  }
  return evidenceRoot;
}

function runLiteralCompilerControls() {
  const runId = Date.now() + '-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  const evidenceRoot = path.join(repoRoot, 'build/collection-lifecycle-native-evidence/literals', runId);
  fs.mkdirSync(evidenceRoot, {recursive:true});
  const compiler = path.join(process.env.SBF_TOOLS
    ?? path.join(os.homedir(), '.cache/solana/v1.53/platform-tools/llvm/bin'), 'clang');
  const version = spawnSync(compiler, ['--version'], {encoding:'utf8', timeout:15_000});
  assert.ifError(version.error);
  assert.equal(version.status, 0, 'pinned C compiler --version');
  const versionText = (version.stdout || '') + (version.stderr || '');
  assert.match(versionText, /clang version 20\.1\.7/, 'numeric literal controls must use pinned Anza Clang');

  const cases = [
    {token:'0',value:0,width:32,signed:true,ctype:'int',cType:'int'},
    {token:'0u',value:0,width:32,signed:false,ctype:'u32',cType:'unsigned int'},
    {token:'0U',value:0,width:32,signed:false,ctype:'u32',cType:'unsigned int'},
    {token:'0ull',value:0,width:64,signed:false,ctype:'u64',cType:'unsigned long long'},
    {token:'0ULL',value:0,width:64,signed:false,ctype:'u64',cType:'unsigned long long'},
    {token:'10',value:10,width:32,signed:true,ctype:'int',cType:'int'},
    {token:'10u',value:10,width:32,signed:false,ctype:'u32',cType:'unsigned int'},
    {token:'10U',value:10,width:32,signed:false,ctype:'u32',cType:'unsigned int'},
    {token:'10ULL',value:10,width:64,signed:false,ctype:'u64',cType:'unsigned long long'},
    {token:'1uLL',value:1,width:64,signed:false,ctype:'u64',cType:'unsigned long long'},
    {token:'1Ull',value:1,width:64,signed:false,ctype:'u64',cType:'unsigned long long'},
    {token:'0x0',value:0,width:32,signed:true,ctype:'int',cType:'int'},
    {token:'0X10U',value:16,width:32,signed:false,ctype:'u32',cType:'unsigned int'},
    {token:'0x7fffffff',value:2147483647,width:32,signed:true,ctype:'int',cType:'int'},
    {token:'0x80000000',value:2147483648,width:32,signed:false,ctype:'u32',cType:'unsigned int'},
    {token:'0xFFFFFFFF',value:4294967295,width:32,signed:false,ctype:'u32',cType:'unsigned int'},
    {token:'0xffffffffu',value:4294967295,width:32,signed:false,ctype:'u32',cType:'unsigned int'},
    {token:'0xffffffffffffffffULL',value:'18446744073709551615',width:64,signed:false,
      ctype:'u64',cType:'unsigned long long'},
    {token:'2147483647',value:2147483647,width:32,signed:true,ctype:'int',cType:'int'},
  ];
  const sourceLines = [
    ...cases.flatMap(({token,cType,value}) => [
      `_Static_assert(_Generic((${token}), ${cType}:1, default:0), "type ${token}");`,
      `_Static_assert((unsigned long long)(${token}) == ${String(value)}ULL, "value ${token}");`,
    ]),
    '_Static_assert(010 == 8, "C17 leading-zero integer constants are octal");',
    '_Static_assert(010u == 8u, "unsigned C17 octal constants are octal");',
    '',
  ];
  const source = sourceLines.join('\n');
  const sourceFile = path.join(evidenceRoot, 'accepted.c');
  fs.writeFileSync(sourceFile, source);
  const compileArgs = ['--target=sbf', '-std=c17', '-Wall', '-Wextra', '-Werror',
    '-fsyntax-only', sourceFile];
  const compile = spawnSync(compiler, compileArgs, {cwd:evidenceRoot,encoding:'utf8',timeout:30_000});
  fs.writeFileSync(path.join(evidenceRoot, 'accepted.compile.log'), JSON.stringify({
    compiler, version:versionText, command:compileArgs, status:compile.status,
    signal:compile.signal, error:compile.error?.message, stdout:compile.stdout, stderr:compile.stderr,
  }, null, 2) + '\n');
  assert.ifError(compile.error);
  assert.equal(compile.status, 0, 'accepted literal type/value assertions; evidence=' + evidenceRoot);

  const parsedCases = [];
  for (const testCase of cases) {
    const result = spawnSync(python, ['-B', 'verification/collection_lifecycle.py',
      '--literal-probe', testCase.token], {cwd:repoRoot,encoding:'utf8',timeout:15_000});
    assert.ifError(result.error);
    assert.equal(result.status, 0, 'checker accepts ' + testCase.token + '; ' + result.stderr);
    const parsed = JSON.parse(result.stdout.trim());
    const expected = {...testCase, value:String(testCase.value)};
    delete (expected as Record<string,unknown>).cType;
    assert.deepEqual(parsed, expected, 'checker literal interpretation for ' + testCase.token);
    parsedCases.push(parsed);
  }
  const rejectedTokens = ['010','010u','08','09','0L','1uLl','1ulL'];
  for (const token of rejectedTokens) {
    const result = spawnSync(python, ['-B', 'verification/collection_lifecycle.py',
      '--literal-probe', token], {cwd:repoRoot,encoding:'utf8',timeout:15_000});
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, 'checker must reject unsupported literal ' + token);
    assert.match(result.stderr || '', token === '0L'
      ? /literal: unsupported suffix/
      : token === '1uLl' || token === '1ulL'
        ? /literal: invalid integer suffix/
        : /literal: unsupported leading-zero nonhex integer literal/,
    'literal rejection reason for ' + token);
  }
  for (const [index,token] of ['08','09','1uLl','1ulL'].entries()) {
    const invalidSource = `int invalid_literal = ${token};\n`;
    const invalidFile = path.join(evidenceRoot, `invalid-${index}-${token}.c`);
    fs.writeFileSync(invalidFile, invalidSource);
    const invalid = spawnSync(compiler, ['--target=sbf','-std=c17','-Wall','-Wextra','-Werror',
      '-fsyntax-only',invalidFile], {cwd:evidenceRoot,encoding:'utf8',timeout:30_000});
    fs.writeFileSync(path.join(evidenceRoot, `invalid-${index}-${token}.compile.log`), JSON.stringify({
      compiler, command:['--target=sbf','-std=c17','-Wall','-Wextra','-Werror','-fsyntax-only',invalidFile],
      status:invalid.status,signal:invalid.signal,error:invalid.error?.message,
      stdout:invalid.stdout,stderr:invalid.stderr,
    }, null, 2) + '\n');
    assert.ifError(invalid.error);
    assert.notEqual(invalid.status, 0, 'pinned C compiler must reject unsupported literal ' + token);
  }
  fs.writeFileSync(path.join(evidenceRoot, 'literal-probes.json'), JSON.stringify({
    compiler,version:versionText,accepted:parsedCases,
    rejected:rejectedTokens,
    compilerOctalControls:['010 == 8','010u == 8u'],
  },null,2) + '\n');
  return evidenceRoot;
}

function runNativeWitnesses() {
  return [
  runNativePair('record_commit_octal_caller_valid', String.raw`#include <stdio.h>
#include "bend_collection_runtime.h"
int main(void) {
  static u8 rec[56 + 8 * 4], enc[8], header[20], key[32];
  Account r = {0}; r.data = rec; r.size = sizeof rec;
  BendCollection c = {&r, 3, 4, 8};
  BendCollectionWindow w = {0};
  if (!bend_collection_select(&c, 1, 2, 2, &w)) return 2;
  const u8 *p = bend_collection_record(&c, &w, 0);
  printf("record_local0_offset=%lld (contract 64)\n", (long long)(p - rec));

  BendCollection cc = {&r, 3, 4, 8};
  BendCollectionWindow ww = {0};
  if (!bend_collection_select(&cc, 1, 1, 1, &ww) ||
      !bend_collection_plan(&cc, &ww, 1, 3)) return 3;
  bend_collection_commit(&cc, &ww, 1, 3, enc, header, key);
  printf("commit_length=%u (contract 3) stored_le_length=%u\n", cc.length, (unsigned)rec[20]);
  return 0;
}
`, [
    {oldText:'  if (local >= w->loaded) return (const u8 *)0;\n',
      newText:'  if (local >= w->loaded) return (const u8 *)0;\n  local = local + (10u - 010u);\n'},
    {oldText:'  c->length = next_length;',
      newText:'  c->length = next_length + (u32)(10 - 010);'},
  ], undefined,
  /record_local0_offset=64 \(contract 64\)\ncommit_length=3 \(contract 3\) stored_le_length=3\n/,
  /record_local0_offset=80 \(contract 64\)\ncommit_length=5 \(contract 3\) stored_le_length=3\n/),
  runLiteralCompilerControls(),
  runNativePair('open_first_false_loop', String.raw`#include <stdio.h>
#include "bend_collection_runtime.h"
int main(void) {
  u8 owner[32] = {0}, program[32] = {0}, key[32] = {0}, header[20] = {0};
  u8 data[128] = {0}; data[110] = 1;
  Account account = {0}; account.owner = owner; account.data = data; account.size = sizeof data;
  account.writable = 1; account.signer = 1;
  BendCollection out = {0};
  printf("open_rc=%llu\n", (unsigned long long)bend_collection_open(
      &account, program, key, header, 8, 1, &out));
  return 0;
}
`, 'for (u64 i = 0; i < a->size; ++i) if (a->data[i]) return 4;',
  'for (u64 i = 0; i != 100; ++i) if (a->data[i]) return 4;',
  /open_rc=4\n/, /open_rc=0\n/),

  runNativePair('record_signed_division', String.raw`#include <stdio.h>
#include "bend_collection_runtime.h"
int main(void) {
  static u8 data[56 + 8 * 4];
  Account account = {0}; account.data = data; account.size = sizeof data;
  BendCollection collection = {&account, 3, 4, 8};
  BendCollectionWindow window = {1, 2, 2};
  const u8 *record = bend_collection_record(&collection, &window, 1);
  printf("record_offset=%lld\n", (long long)(record - data));
  return 0;
}
`, 'if (local >= w->loaded) return (const u8 *)0;',
  'if (local >= w->loaded) return (const u8 *)0;\n  local = local + (u32)(((int)0 - 7) / 2 + 4);',
  /record_offset=72\n/, /record_offset=80\n/),

  runNativePair('record_oob_account_extent', String.raw`#include <stdio.h>
#include "bend_collection_runtime.h"
int main(void) {
  static u8 data[8192]; data[4160] = 1;
  Account account = {0}; account.data = data; account.size = 64;
  BendCollection collection = {&account, 1, 1, 8};
  BendCollectionWindow window = {0, 1, 1};
  const u8 *record = bend_collection_record(&collection, &window, 0);
  printf("record_offset=%lld\n", record ? (long long)(record - data) : -1ll);
  return 0;
}
`, 'if (local >= w->loaded) return (const u8 *)0;',
  'if (local >= w->loaded || (c->account->data[c->account->size + 4096] & 1)) return (const u8 *)0;',
  /record_offset=56\n/, /record_offset=-1\n/),

runNativePair('record_compensated_pointer_formation', String.raw`#include <stdio.h>
#include "bend_collection_runtime.h"
int main(void) {
  static u8 backing[256];
  u8 *data = backing + 56;
  Account account = {0}; account.data = data; account.size = 56 + 8 * 4;
  BendCollection collection = {&account, 3, 4, 8};
  BendCollectionWindow window = {1, 2, 2};
  const u8 *record = bend_collection_record(&collection, &window, 0);
  printf("record_offset=%lld\n", (long long)(record - data));
  return 0;
}
`, 'return c->account->data + BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride;',
  'return c->account->data - 56 + 112 + (u64)(w->start + local) * c->stride;',
  /record_offset=64\n/, /record_offset=64\n/),

  runNativePair('commit_unsigned_unary_offset', String.raw`#include <stdio.h>
#include <stddef.h>
#include <sys/mman.h>
#include "bend_collection_runtime.h"
#ifndef MAP_ANONYMOUS
#define MAP_ANONYMOUS MAP_ANON
#endif
#ifndef MAP_NORESERVE
#define MAP_NORESERVE 0
#endif
int main(void) {
  u64 span = (1ull << 35) + 4096;
  u8 *base = mmap(0, (size_t)span, PROT_READ | PROT_WRITE,
      MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  if (base == MAP_FAILED) return 77;
  u8 *data = base + (1ull << 35);
  static u8 encoded[8], header[20], key[32];
  for (int i = 0; i < 8; ++i) encoded[i] = 0xaa;
  Account account = {0}; account.data = data; account.size = 56 + 8 * 4;
  BendCollection collection = {&account, 1, 4, 8};
  BendCollectionWindow window = {1, 1, 0};
  bend_collection_commit(&collection, &window, 1, 2, encoded, header, key);
  printf("data64=0x%02x base64=0x%02x\n", data[64], base[64]);
  return 0;
}
`, 'u64 offset = BEND_COLLECTION_HEADER + (u64)w->start * c->stride;',
  'u64 offset = BEND_COLLECTION_HEADER + (0ull - (u64)(-w->start)) * c->stride;',
  /data64=0xaa base64=0x00\n/, /data64=0x00 base64=0xaa\n/),

  runNativePair('commit_wrapped_intermediate_offset', String.raw`#include <stdio.h>
#include <stddef.h>
#include <sys/mman.h>
#include "bend_collection_runtime.h"
#ifndef MAP_ANONYMOUS
#define MAP_ANONYMOUS MAP_ANON
#endif
#ifndef MAP_NORESERVE
#define MAP_NORESERVE 0
#endif
int main(void) {
  u64 span = (1ull << 32) + 4096;
  u8 *base = mmap(0, (size_t)span, PROT_READ | PROT_WRITE,
      MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  if (base == MAP_FAILED) return 77;
  u8 *data = base + (1ull << 32);
  static u8 encoded[8], header[20], key[32];
  for (int i = 0; i < 8; ++i) encoded[i] = 0xaa;
  Account account = {0}; account.data = data; account.size = 56 + 8 * 4;
  BendCollection collection = {&account, 1, 4, 8};
  BendCollectionWindow window = {1, 1, 0};
  bend_collection_commit(&collection, &window, 1, 2, encoded, header, key);
  printf("data64=0x%02x base64=0x%02x\n", data[64], base[64]);
  return 0;
}
`, 'u64 offset = BEND_COLLECTION_HEADER + (u64)w->start * c->stride;',
  'u64 offset = BEND_COLLECTION_HEADER + (u64)w->start * c->stride;\n  offset = (offset - (u64)(u32)offset) + (0ull - (u64)(-(u32)offset));',
  /data64=0xaa base64=0x00\n/, /data64=0x00 base64=0xaa\n/),

  runNativePair('commit_u32_subscript_wrap', String.raw`#include <stdio.h>
#include <stddef.h>
#include <sys/mman.h>
#include "bend_collection_runtime.h"
#ifndef MAP_ANONYMOUS
#define MAP_ANONYMOUS MAP_ANON
#endif
#ifndef MAP_NORESERVE
#define MAP_NORESERVE 0
#endif
int main(void) {
  const u32 start = 536870903u, capacity = start + 16u;
  const u64 size = 56ull + (u64)capacity * 8ull;
  u8 *data = mmap(0, (size_t)size, PROT_READ | PROT_WRITE,
      MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  if (data == MAP_FAILED) return 77;
  static u8 encoded[128], header[20], key[32];
  for (unsigned i = 0; i < 128; ++i) encoded[i] = 0xaa;
  Account account = {0}; account.data = data; account.size = size;
  BendCollection collection = {&account, start, capacity, 8};
  BendCollectionWindow window = {start, 16, 0};
  bend_collection_commit(&collection, &window, 16, capacity, encoded, header, key);
  printf("data56=0x%02x\n", data[56]);
  return 0;
}
`, 'u64 offset = BEND_COLLECTION_HEADER + (u64)w->start * c->stride;\n  for (u64 i = 0; i < (u64)written * c->stride; ++i) data[offset + i] = encoded[i];',
  'u32 offset = (u32)(BEND_COLLECTION_HEADER + (u64)w->start * c->stride);\n  for (unsigned i = 0; i < (u64)written * c->stride; ++i) data[offset + i] = encoded[i];',
  /data56=0x00\n/, /data56=0xaa\n/),

  runNativePair('commit_zero_offset_pointer_alias', String.raw`#include <stdio.h>
#include "bend_collection_runtime.h"
int main(void) {
  static u8 data[56 + 8 * 4], encoded[8], header[20], key[32];
  for (unsigned i = 0; i < sizeof encoded; ++i) encoded[i] = 0xaa;
  Account account = {0}; account.data = data; account.size = sizeof data;
  BendCollection collection = {&account, 1, 4, 8};
  BendCollectionWindow window = {1, 1, 0};
  bend_collection_commit(&collection, &window, 1, 2, encoded, header, key);
  printf("data64=0x%02x\n", data[64]);
  return 0;
}
`, 'u8 *data = c->account->data;',
  'u8 *data = c->account->data + 0ull;',
  /data64=0xaa\n/, /data64=0xaa\n/),

  runNativePair('commit_compensated_pointer_base', String.raw`#include <stdio.h>
#include "bend_collection_runtime.h"
int main(void) {
  static u8 backing[256], encoded[8], header[20], key[32];
  u8 *data = backing + 56;
  header[0] = 0xaa;
  for (unsigned i = 0; i < sizeof encoded; ++i) encoded[i] = 0xbb;
  Account account = {0}; account.data = data; account.size = 56 + 8 * 4;
  BendCollection collection = {&account, 1, 4, 8};
  BendCollectionWindow window = {1, 1, 0};
  bend_collection_commit(&collection, &window, 1, 2, encoded, header, key);
  printf("data0=0x%02x data64=0x%02x backing0=0x%02x\n",
      data[0], data[64], backing[0]);
  return 0;
}
`, 'u8 *data = c->account->data;\n  u64 offset = BEND_COLLECTION_HEADER + (u64)w->start * c->stride;',
  'u8 *data = c->account->data - 56;\n  u64 offset = 112 + (u64)w->start * c->stride;',
  /data0=0xaa data64=0xbb backing0=0x00\n/,
  /data0=0x00 data64=0xbb backing0=0xaa\n/),

  runNativeFaultPair('commit_oob_read_in_write_le_value', String.raw`#include <stdio.h>
#include <stddef.h>
#include <signal.h>
#include <unistd.h>
#include <sys/mman.h>
#include "bend_collection_runtime.h"
#ifndef MAP_ANONYMOUS
#define MAP_ANONYMOUS MAP_ANON
#endif
static void guard_handler(int sig) {
  const char *message = sig == SIGBUS ? "guard_page_fault=SIGBUS\n" : "guard_page_fault=SIGSEGV\n";
  (void)write(STDOUT_FILENO, message, sig == SIGBUS ? 24 : 25);
  _exit(0);
}
int main(void) {
  (void)signal(SIGBUS, guard_handler);
  (void)signal(SIGSEGV, guard_handler);
  size_t page = (size_t)sysconf(_SC_PAGESIZE);
  u8 *mapping = mmap(0, page * 2, PROT_READ | PROT_WRITE,
      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (mapping == MAP_FAILED || page < 16) return 77;
  if (mprotect(mapping + page, page, PROT_NONE)) return 78;
  u8 *encoded = mapping + page - 8;
  for (unsigned i = 0; i < 8; ++i) encoded[i] = (u8)(0xa0 + i);
  static u8 data[56 + 8], header[20], key[32];
  Account account = {0}; account.data = data; account.size = sizeof data;
  BendCollection collection = {&account, 1, 1, 8};
  BendCollectionWindow window = {0, 1, 1};
  bend_collection_commit(&collection, &window, 1, 1, encoded, header, key);
  printf("length_byte=0x%02x record_byte=0x%02x\n", data[20], data[56]);
  return 0;
}
`, 'write_le(data + 20, next_length, 4);',
  'write_le(data + 20, next_length + (u32)(encoded[8ull] * 0ull), 4);',
  /length_byte=0x01 record_byte=0xa0\n/),

  runNativeTimeoutPair('open_braced_induction_nontermination', String.raw`#include <stdio.h>
#include "bend_collection_runtime.h"
int main(void) {
  u8 owner[32] = {0}, program[32] = {0}, key[32] = {0}, header[20] = {0};
  u8 data[128] = {0};
  Account account = {0}; account.owner = owner; account.data = data; account.size = sizeof data;
  account.writable = 1; account.signer = 1;
  BendCollection out = {0};
  printf("open_rc=%llu\n", (unsigned long long)bend_collection_open(
      &account, program, key, header, 8, 1, &out));
  return 0;
}
`, 'for (u64 i = 0; i < a->size; ++i) if (a->data[i]) return 4;',
  'for (u64 i = 0; i < a->size; ++i) { if (a->data[i]) return 4; i = i - 1; }'),
  ];
}

const seed = makeFixture();
let bytes: Buffer;
try {
  bytes = Buffer.from(JSON.stringify(validReport(seed), null, 2) + '\n');
} finally {
  fs.rmSync(seed, {recursive:true, force:true});
}
caseArchiveConflict(bytes);
runFailureCase(bytes, 'published-nonzero', /child exited 29/, true);
runFailureCase(bytes, 'unknown', /UNKNOWN is not a proof/, false);
runFailureCase(bytes, 'source-drift', /source changed|source hashes/i, true);
runFailureCase(bytes, 'malformed', /receipt top-level|exact fields|child result/i, true);
runFailureCase(bytes, 'forged', /receipt top-level|exact fields|child result/i, true);
runFailureCase(bytes, 'negative-open-restriction-missing', /open exact grammar restriction inventory and content/, true);
runFailureCase(bytes, 'negative-record-restriction-replaced', /record exact grammar restriction inventory and content/, true);
runFailureCase(bytes, 'negative-commit-restriction-extra', /commit exact grammar restriction inventory and content/, true);
runFailureCase(bytes, 'negative-assumption-missing', /assumption inventory and exact content/, true);
runFailureCase(bytes, 'negative-assumption-replaced', /assumption inventory and exact content/, true);
runFailureCase(bytes, 'negative-assumption-counterfeit', /assumption inventory and exact content/, true);
runFailureCase(bytes, 'negative-generic-octal-reason', /must reject for literal semantics/, true);
caseSuccessfulPublication(bytes);
const nativeEvidence = runNativeWitnesses();
process.stdout.write('PASS collection lifecycle receipt: quarantine-before-archive, archive conflict, failed output, UNKNOWN, source drift, malformed/forged child, atomic publish, native witnesses=' + JSON.stringify(nativeEvidence) + '\n');
