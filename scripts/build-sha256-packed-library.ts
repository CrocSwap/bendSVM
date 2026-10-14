import {buildQualifiedPackedShaLibrary} from './qualified-library.ts';

if (import.meta.main) {
  const [source,root,directory,...extra] = process.argv.slice(2);
  if (!source || !root || !directory || extra.length) {
    console.error('Usage: bun scripts/build-sha256-packed-library.ts PROOF.bend namespace.function output-directory');
    process.exit(1);
  }
  try {
    await buildQualifiedPackedShaLibrary(source,root,directory);
  } catch (error) {
    console.error(error instanceof Error?error.message:String(error));
    process.exit(1);
  }
}
