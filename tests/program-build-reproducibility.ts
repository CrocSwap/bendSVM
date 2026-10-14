import assert from 'node:assert/strict';
import fs from 'node:fs';
import { verifyFinalSbfArtifactReceipt, type SbfCallDepthArtifactReceipt } from '../compiler/sbf-call-depth-artifact.ts';

export interface ProgramBuildSnapshot {
  manifest: unknown;
  manifestPath: string;
  elfPath: string;
}

type ProgramBuildManifest = Record<string, any> & {
  buildRunId: string;
  sbfCallDepth: SbfCallDepthArtifactReceipt;
};

function stableBuild(snapshot: ProgramBuildSnapshot): { manifest: ProgramBuildManifest; report: Record<string, any> } {
  assert(snapshot.manifest && typeof snapshot.manifest === 'object' && !Array.isArray(snapshot.manifest),
    'Program build must return a manifest object');
  const manifest = snapshot.manifest as ProgramBuildManifest;
  const published = JSON.parse(fs.readFileSync(snapshot.manifestPath, 'utf8'));
  assert.deepEqual(published, manifest, 'returned manifest must match the on-disk success manifest');

  const receipt = manifest.sbfCallDepth;
  assert(receipt, 'Success manifest must include the final-ELF call-depth receipt');
  assert.equal(typeof manifest.buildRunId, 'string', 'manifest must identify its build run');
  assert(manifest.buildRunId.length > 0);
  assert.notEqual(manifest.buildRunId, receipt.runId, 'build and gate run IDs must identify separate stages');
  assert.equal(manifest.inputs?.[receipt.checker.path], receipt.checker.sha256,
    'manifest inputs must bind the checker source used by the receipt');
  verifyFinalSbfArtifactReceipt(receipt, snapshot.elfPath);

  const elfArtifact = manifest.artifacts?.['.so'];
  assert(elfArtifact, 'Success manifest must bind its final ELF in the artifacts map');
  assert.equal(typeof elfArtifact === 'string' ? elfArtifact : elfArtifact.sha256, receipt.artifact.sha256,
    'manifest ELF hash must match its independently verified receipt');
  assert.equal(manifest.elfBytes ?? (typeof elfArtifact === 'string' ? undefined : elfArtifact.bytes), receipt.artifact.byteLength,
    'manifest ELF length must match its independently verified receipt');

  const stable = structuredClone(manifest) as Record<string, any>;
  // These values identify one publication or its output location. All content,
  // artifact hashes, toolchain/input/schema identities, and stable receipt
  // fields remain in the comparison.
  delete stable.buildRunId;
  delete stable.priorEvidenceArchive;
  delete stable.sbfCallDepth.runId;
  delete stable.sbfCallDepth.artifact.path;
  delete stable.sbfCallDepth.report.path;
  delete stable.sbfCallDepth.report.sha256;
  delete stable.sbfCallDepth.report.byteLength;

  const report = structuredClone(JSON.parse(fs.readFileSync(receipt.report.path, 'utf8'))) as Record<string, any>;
  delete report.runId;
  delete report.artifact.path;
  return { manifest: stable as ProgramBuildManifest, report };
}

export function programBuildSnapshot(manifest: unknown, stem: string): ProgramBuildSnapshot {
  return { manifest, manifestPath: `${stem}.manifest.json`, elfPath: `${stem}.so` };
}

/** Compare reproducible build content while validating each run's exact ELF receipt. */
export function assertReproducibleProgramBuilds(first: ProgramBuildSnapshot, second: ProgramBuildSnapshot, message?: string): void {
  const firstStable = stableBuild(first);
  const secondStable = stableBuild(second);
  assert.deepEqual(secondStable, firstStable, message ?? 'Fresh output directory must reproduce all stable build content and identities');
}
