// Content-addressed cache for Bend interpreter (term_snf) reference results.
// A result is reused only when every input that can affect it is byte-identical:
// the checked source files, the pinned Bend checker/interpreter and base library,
// the backend that loads the book, the harness and wire codec, the emitted
// schema, and the case itself. Results are still compared with the independent
// TypeScript oracle on every run.
//
// BEND_REFERENCE_CACHE=use (default) | off (always evaluate, never write) |
//   refresh (evaluate and overwrite) | verify (evaluate and require equality
//   with any cached entry).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CACHE_DIR = path.resolve('build/.bend-reference-cache');
const FIXED_INPUTS = ['.deps/bend/bend2/bend.ts', '.deps/bend/bend2/base.bend', 'compiler/backend.ts',
  'tests/pure.ts', 'tests/bend-reference-cache.ts', 'sdk/wire.ts'];
type Mode = 'use' | 'off' | 'refresh' | 'verify';

const sha256 = (data: string | Uint8Array) => crypto.createHash('sha256').update(data).digest('hex');

export function referenceCache(sourceFiles: string[], schema: unknown) {
  const mode = (process.env.BEND_REFERENCE_CACHE ?? 'use') as Mode;
  if (!['use', 'off', 'refresh', 'verify'].includes(mode)) throw new Error(`Unknown BEND_REFERENCE_CACHE=${mode}`);
  const files = [...new Set([...sourceFiles.map(file => path.resolve(file)), ...FIXED_INPUTS.map(file => path.resolve(file))])].sort();
  const inputs = Object.fromEntries(files.map(file => [path.relative(process.cwd(), file), sha256(fs.readFileSync(file))]));
  const context = sha256(JSON.stringify({ inputs, schema }));
  const stats = { mode, hits: 0, evaluated: 0, verified: 0, context };
  const entryPath = (key: string) => path.join(CACHE_DIR, key.slice(0, 2), `${key}.json`);

  return {
    stats,
    /** Return the encoded reference result for a case, evaluating only on a valid miss. */
    result(caseKey: unknown, evaluate: () => Uint8Array): Uint8Array {
      const key = sha256(JSON.stringify({ context, caseKey }, (_k, v) => typeof v === 'bigint' ? `${v}n` : v));
      const file = entryPath(key);
      let cached: number[] | undefined;
      if (mode !== 'off' && mode !== 'refresh' && fs.existsSync(file)) {
        try {
          const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (entry.key === key && entry.context === context && Array.isArray(entry.result)) cached = entry.result;
        } catch { cached = undefined; }
      }
      if (cached && mode === 'use') { stats.hits++; return Uint8Array.from(cached); }
      const fresh = evaluate();
      stats.evaluated++;
      if (cached && mode === 'verify') {
        if (cached.length !== fresh.length || cached.some((byte, index) => byte !== fresh[index])) {
          throw new Error(`Bend reference cache entry ${file} differs from a fresh evaluation`);
        }
        stats.verified++;
      }
      if (mode !== 'off') {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ key, context, inputs, result: [...fresh] }) + '\n');
        fs.renameSync(temporary, file);
      }
      return fresh;
    },
  };
}
