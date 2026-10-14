import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildLibrary } from '../compiler/library.ts';
import { prepareBend } from './build.ts';
import { libraryTarget, libraryOutputStem } from '../compiler/target-profile.ts';
import type { LibraryTarget } from '../compiler/target-profile.ts';

export async function buildPureLibrary(source: string, root: string, stem: string, target?: LibraryTarget) {
  prepareBend();
  return buildLibrary(source, root, libraryOutputStem(stem, target), target);
}

const usage = 'Usage: bun scripts/build-library.ts PROOF.bend namespace.function output-stem [--target fogo-v0|solana-v3] [--json]';

if (import.meta.main) {
  const [source, root, stem, ...rest] = process.argv.slice(2);
  const json = rest.at(-1) === '--json';
  const extra = json ? rest.slice(0, -1) : rest;
  if (!source || !root || !stem || (extra.length !== 0 && (extra.length !== 2 || extra[0] !== '--target'))) {
    console.error(usage);
    process.exit(1);
  }
  // With --json, stdout carries exactly one JSON object; progress goes to stderr.
  if (json) console.log = (...args: unknown[]) => console.error(...args);
  try {
    const target = extra.length ? libraryTarget(extra[1]).name : undefined;
    const manifest = await buildPureLibrary(source, root, stem, target);
    if (json) {
      const file = `${libraryOutputStem(stem, target)}.manifest.json`;
      process.stdout.write(JSON.stringify({
        ok: true, manifest: path.resolve(file),
        manifestSha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        targetProfile: manifest.targetProfile, platformTools: manifest.toolchains.anzaClang.platformTools,
        root: manifest.root, symbol: manifest.symbol, schemaFingerprint: manifest.schemaFingerprint,
      }) + '\n');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
    console.error(message);
    process.exit(1);
  }
}
