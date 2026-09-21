import { checkedBook, Backend, describeError } from './backend.ts';
import { writeArtifacts } from './artifacts.ts';

const [proof, root, out, ...extra] = process.argv.slice(2);
if (!proof || !root || !out || extra.length > 1 || (extra.length === 1 && extra[0] !== '--storage')) {
  console.error('Usage: bun compiler/cli.ts PROOF.bend namespace.function output.h [--storage]');
  process.exit(1);
}
try {
  const result = new Backend(await checkedBook(proof)).emit([root]);
  if (!out.endsWith('.h')) throw new Error('Output must end with .h');
  writeArtifacts(out.slice(0, -2), result, extra[0] === '--storage' ? root : undefined);
  console.log(`Checked and emitted ${result.functions.join(', ')} → ${out}`);
} catch (e) {
  console.error(describeError(e));
  process.exit(1);
}
