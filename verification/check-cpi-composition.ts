import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const reportPath = 'build/cpi-composition-refinement.json';
const pendingPath = `${reportPath}.pending`;
fs.mkdirSync('build', {recursive:true});
// A failed or timed out run must never leave a prior successful report behind.
if (fs.existsSync(reportPath)) {
  const digest=crypto.createHash('sha256').update(fs.readFileSync(reportPath)).digest('hex');
  fs.mkdirSync('build/refinement-reports', {recursive:true});
  fs.copyFileSync(reportPath, `build/refinement-reports/${digest}.json`);
}
fs.rmSync(reportPath, {force:true});
fs.rmSync(pendingPath, {force:true});
const result = spawnSync(process.env.PYTHON ?? 'python3',
  ['-B', 'verification/cpi_composition.py'],
  {encoding:'utf8', timeout:180_000, maxBuffer:1 << 22});
assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr || result.stdout);

try {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.passed, true);
  assert.equal(report.z3, '5.1.0');
  assert.equal(report.solverFailureBehavior.forcedUnknownRejected, true);
  assert.equal(report.solverFailureBehavior.solverTimeoutMs, 30_000);
  assert.equal(report.solverFailureBehavior.hostChildTimeoutMs, 180_000);
  assert.deepEqual(
    {min:report.inputPreconditions.accountCount.min, max:report.inputPreconditions.accountCount.max},
    {min:4, max:12});
  assert(report.inputPreconditions.accountCount.status.includes('input assumption'));
  assert.equal(report.compositionStatus.result,
    'conditional component obligations; emitted-adapter composition is not established');
  assert(report.compositionStatus.hostAdapterMustEstablish.length >= 5);
  assert.equal(report.validatorClaims.length, 3);
  assert(report.validatorClaims.every((claim:any) => claim.result === 'unsat'));
  assert.equal(report.conditionalValidatorFacts.length, 32);
  assert(report.conditionalValidatorFacts.every((claim:any) => claim.result === 'unsat'));
  assert.equal('compositionClaims' in report, false);
  assert.equal(report.mathematicalAdapterLoopObligation.result, 'unsat');
  assert(report.mathematicalAdapterLoopObligation.premise.includes('active success'));
  assert(report.mathematicalAdapterLoopObligation.premise.includes('same effect'));
  assert.equal(report.mathematicalAdapterLoopObligation.validatorImplication,
    'active success bounds meta count to 8');
  assert(report.mathematicalAdapterLoopObligation.scope.includes('no compiler-template'));
  assert.equal(report.witnesses.length, 4);
  assert(report.witnesses.every((witness:any) => witness.smtModel || witness.counterexample));
  assert.equal(report.mutations.validatorSemantic.length, 5);
  assert(report.mutations.validatorSemantic.every((mutation:any) =>
    mutation.kind === 'semantic' && mutation.counterexample && mutation.violated.length > 0));
  assert.equal(report.mutations.executorCGrammar.length, 8);
  assert(report.mutations.executorCGrammar.every((mutation:any) =>
    mutation.kind === 'grammar' && mutation.reason &&
    mutation.boundaryExample.kind === 'input-or-capacity-boundary-example' &&
    mutation.boundaryExample.isExecutionOfMutatedC === false &&
    mutation.boundaryExample.explanation.includes('not an execution')));
  assert.equal('abi2Template' in report.mutations, false);
  assert.equal('abi2ManagedStateScan' in report, false);
  assert.equal(report.equivalents.length, 2);
  assert(report.equivalents.every((variant:any) =>
    ['unsat', 'accepted'].includes(variant.result)));
  assert.equal(report.executorAudit.syscall.argumentCount, 5);
  assert.deepEqual(report.executorAudit.localCapacities, {infos:12, metas:8});
  assert(report.executorAudit.acceptedGrammar.includes('complete live body token stream'));
  assert(report.executorAudit.allowedLocalRefresh.includes('local a[i].size'));
  assert.equal(report.executorAudit.reviewedAccessShape.status,
    'descriptive expressions for the exact token-audited body; not standalone semantic claims');
  assert(report.assumptions.some((item:string) => item.includes('No source-root preservation')));
  assert.equal(report.trustBoundary.sourceRootPreservation,
    'Not claimed; Bend effect extraction and source-root correspondence are outside the gate.');
  for (const entry of [report.runtimeHeaderHashes.validator, report.runtimeHeaderHashes.executor,
      ...Object.values(report.runtimeHeaderHashes.dependencies)]) {
    assert.equal(entry.sha256, report.inputHashes[entry.path], entry.path);
  }

  for (const [file, hash] of Object.entries(report.inputHashes) as [string,string][]) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash, file);
  }
  process.stdout.write(result.stdout);
} catch (error) {
  // A Python report rejected by this host-side contract is not success evidence.
  fs.rmSync(reportPath, {force:true});
  throw error;
}
