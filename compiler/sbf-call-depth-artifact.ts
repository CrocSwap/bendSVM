import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSbfCallDepth, type SbfCallDepthReport } from './sbf-call-depth.ts';

const CHECKER_ABSOLUTE_PATH = fileURLToPath(new URL('./sbf-call-depth.ts', import.meta.url));
const REPORT_SCHEMA_VERSION = 1;
const SUPPORTED_CONFIGURATION: SbfCallDepthConfiguration = {
  profile: 'solana-sbpf-v0',
  sbpfVersion: 0,
  loader: {
    rejectBrokenElfs: false,
    enableSymbolAndSectionLabels: false,
    hostUsizeBytes: 8,
  },
  maxActiveFramesIncludingEntry: 64,
  frameSizeBytes: 4096,
};
const SUPPORTED_ASSUMPTIONS: SbfCallDepthReport['assumptions'] = {
  solanaSbpf: '0.11.1',
  solanaProgramRuntime: '2.3.13',
  maxActiveFramesIncludingEntry: 64,
  frameSizeBytes: 4096,
  checkerMaxTextInstructions: 65_536,
  callx: 'reachable instances refused',
  importKeyCollisions: 'refused when an import hash matches a registered guest-function key',
  loaderFunctionKeys: 'numeric target-PC keys use 64-bit host usize bytes; entrypoint and imports use symbol-name bytes',
  loaderEntryPointRemap: 'defined entrypoint relocations resolve to e_entry; colliding numeric PC keys refused',
  loaderRelocationLookup: 'first program header of any type containing DT_REL in p_memsz, else first exact sh_addr section; mismatched SHT_REL bytes refused',
  loaderDynamicTable: 'first PT_DYNAMIC must be an aligned valid slice; invalid PT_DYNAMIC fallback is refused; aligned SHT_DYNAMIC-only files are supported',
  loaderDynamicSymbols: 'first section at DT_SYMTAB and unique literal .dynstr; 64-byte name limit applies only to referenced R_BPF_64_32 symbols',
  relocationTextWrites: 'all loader write ranges checked; outside-to-text writes refused',
  loaderConfiguration: 'reject_broken_elfs=false and enable_symbol_and_section_labels=false; e_flags=0 selects SBPFv0',
  hostUsizeBytes: 8,
  executionEngine: 'interpreter modeled and exercised; JIT equivalence assumed, not verified',
  syscallScope: 'registry is external; imports are checked for guest-key collisions; syscalls are assumed to add no guest frame',
  cpiScope: 'CPI and nested-program call depth are out of scope',
  syscallFrames: 0,
  terminalSyscalls: 'resolved abort import halts under pinned Solana runtime; other syscalls conservatively return',
  controlFlow: 'both conditional outcomes; direct jumps and fallthrough followed',
  maximumActivationInstructionStates: 1_000_000,
};

export interface SbfCallDepthConfiguration {
  profile: 'solana-sbpf-v0';
  sbpfVersion: 0;
  loader: {
    rejectBrokenElfs: false;
    enableSymbolAndSectionLabels: false;
    hostUsizeBytes: 8;
  };
  maxActiveFramesIncludingEntry: 64;
  frameSizeBytes: 4096;
}

export interface SbfCallDepthArtifactReceipt {
  schemaVersion: 1;
  status: 'accepted';
  runId: string;
  artifact: { path: string; sha256: string; byteLength: number };
  checker: { path: string; sha256: string };
  configuration: SbfCallDepthConfiguration;
  assumptions: SbfCallDepthReport['assumptions'];
  report: { path: string; sha256: string; byteLength: number };
  analysis: {
    reachableInstructionCount: number;
    reachableActivationEntries: number;
    longestFrameCount: number;
    longestFramePath: number[];
    reachableCallEdges: number;
    reachableSyscallEdges: number;
  };
}

interface SbfCallDepthReportArtifact {
  schemaVersion: 1;
  runId: string;
  status: 'accepted' | 'refused';
  artifact: { path: string; sha256: string; byteLength: number };
  checker: { path: string; sha256: string };
  configuration: SbfCallDepthConfiguration | null;
  assumptions: SbfCallDepthReport['assumptions'];
  checkerReport: SbfCallDepthReport | null;
  refusal?: { code: string; message: string };
}

interface SbfCallDepthArtifactErrorEvidence {
  runId?: string;
  buildRunId?: string;
  gateRunId?: string;
  reportPath?: string;
  reportSha256?: string;
  publicationReportPath?: string;
  publicationReportSha256?: string;
}

export class SbfCallDepthArtifactError extends Error {
  constructor(readonly code: string, message: string, readonly evidence: SbfCallDepthArtifactErrorEvidence = {}) {
    super(`${code}: ${message}`);
    this.name = 'SbfCallDepthArtifactError';
  }
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function exactRecord(actual: unknown, expected: object): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actualRecord).sort();
  const expectedKeys = Object.keys(expectedRecord).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, i) => key !== expectedKeys[i])) return false;
  return expectedKeys.every(key => {
    const actualValue = actualRecord[key];
    const expectedValue = expectedRecord[key];
    if (expectedValue && typeof expectedValue === 'object') return exactRecord(actualValue, expectedValue);
    return actualValue === expectedValue;
  });
}

function relativePath(file: string): string {
  const absolute = path.resolve(file);
  const relative = path.relative(process.cwd(), absolute);
  return relative === '..' || relative.startsWith(`..${path.sep}`) ? absolute : relative;
}

function configurationFor(report: SbfCallDepthReport): SbfCallDepthConfiguration | null {
  const { assumptions, target } = report;
  const supported = target.elfType === 'ET_DYN' &&
    (target.machine === 'EM_BPF' || target.machine === 'EM_SBPF') && target.sbpfVersion === 'v0' &&
    exactRecord(assumptions, SUPPORTED_ASSUMPTIONS);
  if (!supported) {
    return null;
  }
  return SUPPORTED_CONFIGURATION;
}

function requireReportPath(reportDirectory: string, runId: string): string {
  const reportPath = path.resolve(reportDirectory, `sbf-call-depth-${runId}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  if (fs.existsSync(reportPath)) {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_REPORT_EXISTS',
      `refusing to overwrite prior report ${relativePath(reportPath)}`);
  }
  return reportPath;
}

function writeReportArtifact(reportPath: string, report: SbfCallDepthReportArtifact): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  let descriptor: number;
  try {
    descriptor = fs.openSync(reportPath, 'wx');
  } catch (error) {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_REPORT_EXISTS',
      `cannot create per-run report ${relativePath(reportPath)}: ${String(error)}`);
  }
  try {
    fs.writeFileSync(descriptor, bytes);
  } finally {
    fs.closeSync(descriptor);
  }
  return bytes;
}

function diagnosticSummary(report: SbfCallDepthReport | null): string {
  if (!report) return 'checker did not produce a report';
  if (report.diagnostics.length === 0) return 'checker returned refused without a diagnostic';
  return report.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join('; ');
}

/**
 * Check one final linked ELF and create a unique, hash-bound report artifact.
 * Callers must not publish build/acceptance success until this returns and the
 * returned receipt has been verified immediately before publication.
 */
export function checkFinalSbfArtifact(elfPath: string, reportDirectory: string): SbfCallDepthArtifactReceipt {
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${crypto.randomUUID()}`;
  const reportPath = requireReportPath(reportDirectory, runId);
  const artifactBytes = fs.readFileSync(elfPath);
  const artifactSha256 = sha256(artifactBytes);
  const checkerPath = relativePath(CHECKER_ABSOLUTE_PATH);
  const checkerSha256Before = sha256(fs.readFileSync(CHECKER_ABSOLUTE_PATH));
  let checkerReport: SbfCallDepthReport | null = null;
  let checkerError: unknown;
  let checkerThrew = false;
  try {
    checkerReport = checkSbfCallDepth(artifactBytes);
  } catch (error) {
    checkerError = error;
    checkerThrew = true;
  }
  let checkerSha256After: string | null = null;
  let checkerSourceError: unknown;
  try {
    checkerSha256After = sha256(fs.readFileSync(CHECKER_ABSOLUTE_PATH));
  } catch (error) {
    checkerSourceError = error;
  }
  const configuration = checkerReport ? configurationFor(checkerReport) : null;
  const missingBound = checkerReport?.status === 'accepted' &&
    (checkerReport.analysis.longestFrameCount === null || checkerReport.analysis.longestFramePath === null);
  const unsupportedProfile = configuration === null
    ? checkerReport
      ? `unsupported final ELF/runtime profile: ${JSON.stringify({ target: checkerReport.target, assumptions: checkerReport.assumptions })}`
      : undefined
    : undefined;
  const checkerChanged = checkerSha256After !== null && checkerSha256Before !== checkerSha256After;
  const checkerFailure = checkerSourceError
    ? { code: 'SBF_CALL_DEPTH_CHECKER_SOURCE_UNAVAILABLE', message: `cannot re-read checker source after analysis: ${String(checkerSourceError)}` }
    : checkerThrew
      ? { code: 'SBF_CALL_DEPTH_CHECKER_ERROR', message: `checker threw: ${String(checkerError)}` }
      : undefined;
  const refusal = checkerChanged
    ? { code: 'SBF_CALL_DEPTH_CHECKER_CHANGED', message: `checker bytes changed during analysis: ${checkerSha256Before} -> ${checkerSha256After}` }
    : checkerFailure
      ? checkerFailure
      : unsupportedProfile
      ? { code: 'SBF_CALL_DEPTH_UNSUPPORTED_PROFILE', message: unsupportedProfile }
      : checkerReport?.status !== 'accepted'
        ? { code: 'SBF_CALL_DEPTH_REFUSED', message: diagnosticSummary(checkerReport) }
        : missingBound
          ? { code: 'SBF_CALL_DEPTH_MISSING_BOUND', message: 'accepted result has no finite frame path' }
        : undefined;
  const artifact = {
    path: relativePath(elfPath),
    sha256: artifactSha256,
    byteLength: artifactBytes.byteLength,
  };
  const checker = { path: checkerPath, sha256: checkerSha256Before };
  const reportArtifact: SbfCallDepthReportArtifact = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId,
    status: refusal ? 'refused' : checkerReport?.status ?? 'refused',
    artifact,
    checker,
    configuration,
    assumptions: checkerReport?.assumptions ?? SUPPORTED_ASSUMPTIONS,
    checkerReport,
    ...(refusal ? { refusal } : {}),
  };
  const reportBytes = writeReportArtifact(reportPath, reportArtifact);

  if (checkerChanged) {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_CHECKER_CHANGED',
      `${refusal!.message}; refusal report ${relativePath(reportPath)} (SHA-256 ${sha256(reportBytes)})`,
      { runId, reportPath: relativePath(reportPath), reportSha256: sha256(reportBytes) });
  }
  if (checkerFailure) {
    throw new SbfCallDepthArtifactError(checkerFailure.code,
      `${checkerFailure.message}; refusal report ${relativePath(reportPath)} (SHA-256 ${sha256(reportBytes)})`,
      { runId, reportPath: relativePath(reportPath), reportSha256: sha256(reportBytes) });
  }
  if (configuration === null) {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_UNSUPPORTED_PROFILE',
      `${unsupportedProfile ?? 'unsupported profile'}; refusal report ${relativePath(reportPath)} (SHA-256 ${sha256(reportBytes)})`,
      { runId, reportPath: relativePath(reportPath), reportSha256: sha256(reportBytes) });
  }
  if (checkerReport?.status !== 'accepted') {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_REFUSED',
      `${diagnosticSummary(checkerReport)}; ELF ${artifact.sha256}; refusal report ${relativePath(reportPath)} (SHA-256 ${sha256(reportBytes)})`,
      { runId, reportPath: relativePath(reportPath), reportSha256: sha256(reportBytes) });
  }
  if (missingBound) {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_MISSING_BOUND',
      `accepted report has no finite frame path; report ${relativePath(reportPath)}`,
      { runId, reportPath: relativePath(reportPath), reportSha256: sha256(reportBytes) });
  }

  const receipt: SbfCallDepthArtifactReceipt = {
    schemaVersion: 1,
    status: 'accepted',
    runId,
    artifact,
    checker,
    configuration,
    assumptions: checkerReport.assumptions,
    report: {
      path: relativePath(reportPath),
      sha256: sha256(reportBytes),
      byteLength: reportBytes.byteLength,
    },
    analysis: {
      reachableInstructionCount: checkerReport.analysis.reachableInstructionCount,
      reachableActivationEntries: checkerReport.analysis.reachableActivationEntries.length,
      longestFrameCount: checkerReport.analysis.longestFrameCount,
      longestFramePath: checkerReport.analysis.longestFramePath,
      reachableCallEdges: checkerReport.analysis.reachableCallEdges.length,
      reachableSyscallEdges: checkerReport.analysis.reachableSyscallEdges.length,
    },
  };
  verifyFinalSbfArtifactReceipt(receipt, elfPath);
  return receipt;
}

/** Run the final-ELF gate and invoke the success publisher only after it passes. */
export function publishAcceptedFinalSbfArtifact<T>(
  elfPath: string,
  reportDirectory: string,
  publish: (receipt: SbfCallDepthArtifactReceipt) => T,
  options: { buildRunId?: string } = {},
): { receipt: SbfCallDepthArtifactReceipt; result: T } {
  const receipt = checkFinalSbfArtifact(elfPath, reportDirectory);
  verifyFinalSbfArtifactReceipt(receipt, elfPath);
  try {
    return { receipt, result: publish(receipt) };
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    const buildRunId = options.buildRunId ?? receipt.runId;
    const reportPath = path.resolve(reportDirectory, `sbf-call-depth-publication-${receipt.runId}.json`);
    const failure = {
      schemaVersion: 1,
      status: 'refused',
      code: 'SBF_CALL_DEPTH_PUBLICATION_FAILED',
      buildRunId,
      gateRunId: receipt.runId,
      artifact: receipt.artifact,
      checker: receipt.checker,
      acceptedGateObservation: {
        status: 'accepted',
        receipt,
        report: receipt.report,
      },
      cause: {
        name: cause.name,
        code: error instanceof SbfCallDepthArtifactError ? error.code : undefined,
        message: cause.message,
      },
    };
    const bytes = Buffer.from(`${JSON.stringify(failure, null, 2)}\n`, 'utf8');
    let failurePath: string | undefined;
    let failureSha256: string | undefined;
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      const descriptor = fs.openSync(reportPath, 'wx');
      try {
        fs.writeFileSync(descriptor, bytes);
      } finally {
        fs.closeSync(descriptor);
      }
      failurePath = relativePath(reportPath);
      failureSha256 = sha256(bytes);
    } catch (evidenceError) {
      throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_PUBLICATION_FAILED',
        `${cause.message}; failed to record publication refusal evidence: ${String(evidenceError)}`,
        { runId: receipt.runId, gateRunId: receipt.runId, buildRunId, reportPath: receipt.report.path,
          reportSha256: receipt.report.sha256 });
    }
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_PUBLICATION_FAILED',
      `${cause.message}; publication refusal report ${failurePath} (SHA-256 ${failureSha256})`,
      { runId: receipt.runId, gateRunId: receipt.runId, buildRunId, reportPath: receipt.report.path,
        reportSha256: receipt.report.sha256, publicationReportPath: failurePath,
        publicationReportSha256: failureSha256 });
  }
}

/** Revalidate an accepted result against current ELF, checker and report bytes. */
export function verifyFinalSbfArtifactReceipt(receipt: SbfCallDepthArtifactReceipt, elfPath: string): void {
  if (!receipt || typeof receipt !== 'object' || !receipt.artifact || !receipt.checker ||
      !receipt.configuration?.loader || !receipt.assumptions || !receipt.report || !receipt.analysis ||
      receipt.schemaVersion !== 1 || receipt.status !== 'accepted') {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_RECEIPT_INVALID', 'receipt is not a schema-v1 accepted result');
  }
  const actualArtifactPath = relativePath(elfPath);
  if (receipt.artifact.path !== actualArtifactPath) {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_ARTIFACT_PATH_MISMATCH',
      `receipt names ${receipt.artifact.path}; pipeline is publishing ${actualArtifactPath}`);
  }
  const artifactBytes = fs.readFileSync(elfPath);
  const actualArtifactSha256 = sha256(artifactBytes);
  if (artifactBytes.byteLength !== receipt.artifact.byteLength || actualArtifactSha256 !== receipt.artifact.sha256) {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_ELF_HASH_MISMATCH',
      `receipt binds ${receipt.artifact.byteLength} bytes/${receipt.artifact.sha256}, current ELF is ${artifactBytes.byteLength} bytes/${actualArtifactSha256}`);
  }
  const checkerPath = relativePath(CHECKER_ABSOLUTE_PATH);
  if (receipt.checker.path !== checkerPath) {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_CHECKER_PATH_MISMATCH',
      `receipt names checker ${receipt.checker.path}; expected ${checkerPath}`);
  }
  const currentCheckerSha256 = sha256(fs.readFileSync(CHECKER_ABSOLUTE_PATH));
  if (currentCheckerSha256 !== receipt.checker.sha256) {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_CHECKER_HASH_MISMATCH',
      `receipt binds checker ${receipt.checker.sha256}; current checker is ${currentCheckerSha256}`);
  }
  if (!exactRecord(receipt.configuration, SUPPORTED_CONFIGURATION)) {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_UNSUPPORTED_PROFILE',
      `receipt contains unsupported profile/configuration ${JSON.stringify(receipt.configuration)}`);
  }
  if (!exactRecord(receipt.assumptions, SUPPORTED_ASSUMPTIONS)) {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_UNSUPPORTED_PROFILE',
      `receipt contains unsupported assumptions ${JSON.stringify(receipt.assumptions)}`);
  }
  const reportPath = path.resolve(receipt.report.path);
  if (!fs.existsSync(reportPath)) {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_REPORT_MISSING',
      `per-run report is missing: ${receipt.report.path}`);
  }
  const reportBytes = fs.readFileSync(reportPath);
  const actualReportSha256 = sha256(reportBytes);
  if (reportBytes.byteLength !== receipt.report.byteLength || actualReportSha256 !== receipt.report.sha256) {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_REPORT_HASH_MISMATCH',
      `receipt binds report ${receipt.report.byteLength} bytes/${receipt.report.sha256}; current report is ${reportBytes.byteLength} bytes/${actualReportSha256}`);
  }
  let report: SbfCallDepthReportArtifact;
  try {
    const parsed = JSON.parse(reportBytes.toString('utf8')) as Partial<SbfCallDepthReportArtifact>;
    if (!parsed || typeof parsed !== 'object' || !parsed.artifact || !parsed.checker ||
        !parsed.configuration || !parsed.assumptions || !parsed.checkerReport?.target ||
        !parsed.checkerReport.analysis || !Array.isArray(parsed.checkerReport.diagnostics) ||
        !Array.isArray(parsed.checkerReport.analysis.reachableActivationEntries) ||
        !Array.isArray(parsed.checkerReport.analysis.reachableCallEdges) ||
        !Array.isArray(parsed.checkerReport.analysis.reachableSyscallEdges) ||
        !Array.isArray(parsed.checkerReport.analysis.longestFramePath)) {
      throw new Error('required report fields are absent');
    }
    report = parsed as SbfCallDepthReportArtifact;
  } catch (error) {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_REPORT_MALFORMED',
      `cannot parse ${receipt.report.path}: ${String(error)}`);
  }
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION || report.status !== 'accepted' ||
      report.runId !== receipt.runId || report.artifact.path !== receipt.artifact.path ||
      report.artifact.sha256 !== receipt.artifact.sha256 || report.artifact.byteLength !== receipt.artifact.byteLength ||
      report.checker.path !== receipt.checker.path || report.checker.sha256 !== receipt.checker.sha256 ||
      JSON.stringify(report.configuration) !== JSON.stringify(receipt.configuration) ||
      JSON.stringify(report.assumptions) !== JSON.stringify(receipt.assumptions) ||
      JSON.stringify(report.checkerReport.assumptions) !== JSON.stringify(receipt.assumptions) ||
      report.checkerReport.target.elfType !== 'ET_DYN' ||
      (report.checkerReport.target.machine !== 'EM_BPF' && report.checkerReport.target.machine !== 'EM_SBPF') ||
      report.checkerReport.target.sbpfVersion !== 'v0' || report.checkerReport.diagnostics.length !== 0 ||
      report.checkerReport.status !== 'accepted' || report.checkerReport.artifact.sha256 !== receipt.artifact.sha256 ||
      report.checkerReport.artifact.byteLength !== receipt.artifact.byteLength ||
      report.checkerReport.analysis.longestFrameCount !== receipt.analysis.longestFrameCount ||
      JSON.stringify(report.checkerReport.analysis.longestFramePath) !== JSON.stringify(receipt.analysis.longestFramePath) ||
      report.checkerReport.analysis.reachableInstructionCount !== receipt.analysis.reachableInstructionCount ||
      report.checkerReport.analysis.reachableActivationEntries.length !== receipt.analysis.reachableActivationEntries ||
      report.checkerReport.analysis.reachableCallEdges.length !== receipt.analysis.reachableCallEdges ||
      report.checkerReport.analysis.reachableSyscallEdges.length !== receipt.analysis.reachableSyscallEdges) {
    throw new SbfCallDepthArtifactError('SBF_CALL_DEPTH_REPORT_BINDING_MISMATCH',
      `report ${receipt.report.path} is stale or does not bind this accepted receipt`);
  }
}
