import fs from 'node:fs';
import path from 'node:path';

export const repositoryRoot = path.resolve(import.meta.dir, '../..');
const referenceFiles = [
  'sdk/sha256-reference.bend',
  'sdk/buffer.bend',
  'sdk/iteration.bend',
  'tests/sha256-reference/PROOF.bend',
  'tests/sha256-reference/LAWS.bend',
];

export type FixtureOptions = {
  relocated?: boolean;
  prelude?: boolean;
  editSource?: (file: string, text: string) => string;
  editSdk?: (relative: string, text: string) => string;
};

export function copyReferenceFixture(directory: string, options: FixtureOptions = {}): string {
  const relocated = options.relocated ?? false;
  for (const relative of referenceFiles) {
    const targetRelative = relocated && relative.startsWith('tests/sha256-reference/')
      ? relative.replace('tests/sha256-reference/', 'app/')
      : relative;
    const destination = path.join(directory, targetRelative);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    let contents = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
    if (relative.startsWith('sdk/')) contents = options.editSdk?.(relative, contents) ?? contents;
    if (relocated && targetRelative.startsWith('app/')) contents = contents.replaceAll('../../sdk/', '../sdk/');
    if (options.prelude && targetRelative === 'app/PROOF.bend') contents = 'import ./before.bend as Before\n' + contents;
    if (targetRelative.endsWith('/PROOF.bend')) contents = options.editSource?.(targetRelative, contents) ?? contents;
    fs.writeFileSync(destination, contents);
  }
  if (options.prelude) {
    const file = path.join(directory, 'app/before.bend');
    fs.writeFileSync(file,
      'import Base\nimport ../sdk/buffer.bend as B\n\n' +
      'def warmup(value: B.Pair<Bool>) -> Bool:\n  B.pair_get(Bool, value, 0)\n');
  }
  return path.join(directory, relocated ? 'app/PROOF.bend' : 'tests/sha256-reference/PROOF.bend');
}

export function copyShadowReferenceFixture(directory: string, shadow: 'buffer' | 'iteration'): string {
  fs.mkdirSync(directory, {recursive: true});
  const read = (relative: string) => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const sha = read('sdk/sha256-reference.bend');
  const buffer = read('sdk/buffer.bend');
  const iteration = read('sdk/iteration.bend');
  const write = (relative: string, contents: string) => {
    const destination = path.join(directory, relative);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.writeFileSync(destination, contents);
  };
  write('lib/sha256-reference.bend', sha);
  write('lib/buffer.bend', shadow === 'buffer'
    ? replaceExactlyOnce(buffer, 'pick(T, left, right, U32.is_zero(index))',
      'pick(T, right, left, U32.is_zero(index))', 'shadow buffer mutation')
    : buffer);
  write('lib/iteration.bend', shadow === 'iteration'
    ? replaceExactlyOnce(iteration, 'repeat(S, step, pred, step(state))',
      'repeat(S, step, pred, state)', 'shadow iteration mutation')
    : iteration);
  if (shadow === 'buffer') write('real/buffer.bend', buffer);
  else write('real/iteration.bend', iteration);

  const laws = replaceExactlyOnce(read('tests/sha256-reference/LAWS.bend'),
    '../../sdk/sha256-reference.bend', '../lib/sha256-reference.bend', 'shadow law import');
  write('app/LAWS.bend', laws);
  let proof = read('tests/sha256-reference/PROOF.bend');
  proof = replaceExactlyOnce(proof, 'import ../../sdk/sha256-reference.bend as SHA',
    'import ../lib/sha256-reference.bend as SHA', 'shadow proof SHA import');
  const unrelated = shadow === 'buffer' ? 'import ../real/buffer.bend as RealBuffer'
    : 'import ../real/iteration.bend as RealIteration';
  proof = proof.replace('import ../lib/sha256-reference.bend as SHA',
    `import ../lib/sha256-reference.bend as SHA\n${unrelated}`);
  write('app/PROOF.bend', proof);
  return path.join(directory, 'app/PROOF.bend');
}

export function copyEmitterSandbox(
  directory: string,
  supportFiles: readonly string[],
  edit: (directory: string) => void,
): string {
  fs.mkdirSync(directory, {recursive: true});
  for (const relative of supportFiles) {
    const source = path.join(repositoryRoot, relative);
    const destination = path.join(directory, relative);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(source, destination);
  }
  for (const relative of [
    'compiler/sha256-qualified-emission.ts',
    'compiler/sha256-qualification-pins.json',
    'sdk/sha256-reference.bend',
    'sdk/buffer.bend',
    'sdk/iteration.bend',
    'tests/sha256-reference/PROOF.bend',
    'tests/sha256-reference/LAWS.bend',
  ]) {
    const source = path.join(repositoryRoot, relative);
    const destination = path.join(directory, relative);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(source, destination);
  }
  for (const dependency of ['.deps', 'node_modules']) {
    fs.symlinkSync(path.join(repositoryRoot, dependency), path.join(directory, dependency), 'dir');
  }
  edit(directory);
  return path.join(directory, 'compiler/sha256-qualified-emission.ts');
}

export function replaceExactlyOnce(source: string, before: string, after: string, label: string): string {
  if (!before || source.split(before).length !== 2) throw new Error(`${label}: expected one mutation site`);
  return source.replace(before, after);
}
