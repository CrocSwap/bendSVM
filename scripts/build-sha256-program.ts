import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildQualifiedShaProgram} from './program.ts';

if (import.meta.main) {
  const [source,root,stem,layout,...extra] = process.argv.slice(2);
  if (!source || !root || !stem || extra.length) {
    console.error('Usage: bun scripts/build-sha256-program.ts PROOF.bend namespace.function output-stem [storage-layout.json]');
    process.exit(1);
  }
  try {
    await buildQualifiedShaProgram(source,root,stem,layout,fileURLToPath(import.meta.url));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
