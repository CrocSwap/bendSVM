import { TargetDiagnostic } from './diagnostics.ts';
export type FieldSchema = { name: string; type: string };
export type VariantSchema = { name: string; tag: number; fields: FieldSchema[]; cMaker: string; sourceName?: string };
export type TypeSchema =
  | { kind: 'u32' | 'bool'; name: string; cType: string; max?: number }
  | { kind: 'adt'; name: string; cType: string; variants: VariantSchema[] };
export type ExportSchema = { name: string; cName: string; args: string[]; result: string };
export type RuntimeSchema = { version: 1; types: TypeSchema[]; exports: ExportSchema[] };

// Fixed-width canonical encodings: a byte tag followed by a constructor's
// fields, zero padded to the width of the largest constructor. No C padding
// or native memory representation is exposed on the wire.
export function wireLayouts(schema: RuntimeSchema): Map<string, number> {
  if (schema.version !== 1) throw new Error('Unsupported runtime schema version');
  const types = new Map(schema.types.map(t => [t.name, t]));
  if (types.size !== schema.types.length) throw new Error('Duplicate schema type');
  const sizes = new Map<string, number>();
  const busy = new Set<string>();
  const size = (name: string): number => {
    if (sizes.has(name)) return sizes.get(name)!;
    if (busy.has(name)) throw new Error(`Recursive wire type: ${name}`);
    const t = types.get(name);
    if (!t) throw new Error(`Unknown wire type: ${name}`);
    busy.add(name);
    let n: number;
    if (t.kind === 'u32') {
      if(t.max!==undefined && (!Number.isInteger(t.max)||t.max<0||t.max>0xffffffff)) throw new Error('Invalid integer bound');
      n = 4;
    }
    else if (t.kind === 'bool') n = 1;
    else {
      if (!t.variants.length || t.variants.length > 256) throw new Error(`Wire constructor count: ${name}`);
      t.variants.forEach((v, i) => {
        if (v.tag !== i || new Set(v.fields.map(f => f.name)).size !== v.fields.length) {
          throw new Error(`Invalid wire constructor: ${v.name}`);
        }
      });
      n = 1 + Math.max(...t.variants.map(v => v.fields.reduce((sum, f) => sum + size(f.type), 0)));
    }
    if (!Number.isSafeInteger(n) || n > 1024) throw new TargetDiagnostic('BEND-SBF201', `Wire value exceeds 1024 bytes: ${name} (${n} bytes)`, 'Reduce the per-call value or window size. Store larger collections in account-backed windows; see docs/collection-storage.md.');
    sizes.set(name, n); busy.delete(name); return n;
  };
  schema.types.forEach(t => size(t.name));
  for (const f of schema.exports) [...f.args, f.result].forEach(size);
  return sizes;
}
