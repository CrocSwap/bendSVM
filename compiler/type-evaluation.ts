import * as B from '../.deps/bend/bend2/bend.ts';
import {TargetDiagnostic} from './diagnostics.ts';

const MAX_COPY_DEPTH = 512;
const MAX_COPY_WORK = 1_000_000;

/**
 * Run the pinned checker's weak-head type evaluator over a private copy of the
 * checked term. This isolates the evaluator's memo-cell writes; it does not
 * sandbox arbitrary JavaScript closures, getters, or proxies.
 */
export function isolatedTypeWhnf(book: B.Book, term: B.HTerm): B.HTerm {
  const copies = new WeakMap<object, any>();
  const owned = new WeakSet<object>();
  const declarationCopies = new WeakMap<object, any>();
  let copyWork = 0;
  let evaluating = true;

  const fail = (): never => {
    throw new TargetDiagnostic(
      'BEND-SBF100',
      'Type evaluation isolation resource limit exceeded',
      'Reduce the size or depth of the checked type graph.',
    );
  };
  const isObject = (value: unknown): value is object | ((...args: any[]) => any) =>
    value !== null && (typeof value === 'object' || typeof value === 'function');

  function markOwnedGraph(value: unknown, seen = new WeakSet<object>(), depth = 0): void {
    if (!isObject(value) || seen.has(value)) return;
    if (depth > MAX_COPY_DEPTH || ++copyWork > MAX_COPY_WORK) fail();
    seen.add(value);
    owned.add(value);
    for (const key of Object.keys(value)) {
      markOwnedGraph((value as any)[key], seen, depth + 1);
    }
  }

  function copy(value: any, depth = 0): any {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
    if (owned.has(value)) return value;
    if (copies.has(value)) return copies.get(value);
    if (depth > MAX_COPY_DEPTH || ++copyWork > MAX_COPY_WORK) fail();

    if (typeof value === 'function') {
      const wrapped = (...args: any[]) => {
        // While term_wnf runs, its binder arguments can contain engine-created
        // memo cells nested below constructors. Preserve all that sharing.
        // A wrapper called after term_wnf returns is externally callable, so
        // copy its arguments instead of claiming caller-owned objects.
        const isolatedArgs = evaluating ? args : args.map((arg) => copy(arg));
        if (evaluating) {
          for (const arg of isolatedArgs) markOwnedGraph(arg);
        }
        return copy(value(...isolatedArgs));
      };
      copies.set(value, wrapped);
      owned.add(wrapped);
      return wrapped;
    }

    const result: any = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    copies.set(value, result);
    owned.add(result);
    for (const key of Object.keys(value)) {
      // Source spans are immutable metadata and deliberately remain shared.
      result[key] = key === 's' ? value[key] : copy(value[key], depth + 1);
    }
    return result;
  }

  function copyDeclaration(value: any): any {
    if (!isObject(value)) return value;
    const prior = declarationCopies.get(value);
    if (prior !== undefined) return prior;

    // Pinned term_wnf reads only these declaration fields. Keeping T, e and c
    // out of the copy avoids rejecting irrelevant deep checker metadata.
    const declaration: any = {$: (value as any).$, n: (value as any).n};
    declarationCopies.set(value, declaration);
    if ((value as any).$ === 'Def') {
      let copied = false;
      let body: any;
      Object.defineProperty(declaration, 'v', {
        enumerable: true,
        get() {
          if (!copied) {
            copied = true;
            body = copy((value as any).v);
          }
          return body;
        },
      });
    }
    return declaration;
  }

  // Preserve direct property lookup, including inherited declarations, just
  // as the pinned evaluator's `book.tlds[name]` does.
  const tlds = new Proxy(book.tlds, {
    get(target, key) {
      const declaration = Reflect.get(target, key, target);
      return declaration === undefined ? undefined : copyDeclaration(declaration);
    },
  });

  let result: B.HTerm;
  try {
    result = B.term_wnf({...book, tlds}, copy(term));
  } finally {
    evaluating = false;
  }
  return copy(result!);
}
