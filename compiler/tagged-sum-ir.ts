// Constructor application and match argument routing. C expressions are opaque
// inputs: this checks routing relative to a schema, not the schema or C semantics.
export type SumFamily = {
  name: string;
  variants: {name: string; sourceName?: string; tag: number; maker: string;
    fields: {name: string; type: string}[]}[];
};
export type SumSource = {constructor: string; arguments: string[]};
type Argument = {kind: 'argument'; index: number; type: string};
type Projection = {kind: 'field'; argument: number; tag: number; index: number; type: string};
export type ConstructIR = {kind: 'construct'; family: string; constructor: string;
  tag: number; arguments: Argument[]};
export type CaseIR = {kind: 'case'; family: string; constructor: string; tag: number;
  scrutinee: Argument; hit: (Argument | Projection)[]; miss: Argument[]};
export type SumEvidence = {family: SumFamily; source: SumSource; ir: ConstructIR | CaseIR};
/** Inspection evidence of the values actually returned by the C renderer. */
export type SumRendering = {operation: number; functionName: string; inputs: string[]} & (
  {kind: 'construct'; expression: string} |
  {kind: 'case'; condition: string; hit: string[]; miss: string[]; block: string[]});


function requireIR(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Tagged-sum IR: ${message}`);
}
function keys(value: object, expected: string[]) {
  requireIR(value !== null && typeof value === 'object' &&
    Object.keys(value).sort().join(',') === expected.sort().join(','), 'unsupported node shape');
}
function variant(family: SumFamily, source: SumSource) {
  requireIR(family.name.length > 0 && family.variants.length > 0, 'empty sum family');
  const names = new Set<string>();
  for (const [index, item] of family.variants.entries()) {
    const name = item.sourceName ?? item.name;
    requireIR(!names.has(name) && item.tag === index, 'noncanonical constructor table');
    names.add(name);
    requireIR(/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.maker), 'invalid maker symbol');
    requireIR(new Set(item.fields.map(f => f.name)).size === item.fields.length &&
      item.fields.every(f => typeof f.type === 'string' && f.type.length > 0), 'invalid field table');
  }
  const found = family.variants.find(v => (v.sourceName ?? v.name) === source.constructor);
  requireIR(found, 'source constructor does not belong to family');
  return found;
}
function argument(index: number, type: string): Argument {return {kind: 'argument', index, type};}
function checkArgument(value: Argument | Projection, index: number, type: string) {
  keys(value, ['kind', 'index', 'type']);
  requireIR(value.kind === 'argument' && value.index === index && value.type === type,
    'argument order or type differs from source');
}

export function validateSumIR(family: SumFamily, source: SumSource, ir: ConstructIR | CaseIR): void {
  const v = variant(family, source);
  requireIR(ir.family === family.name && ir.constructor === v.name && ir.tag === v.tag,
    'constructor family, identity or tag differs from source');
  if (ir.kind === 'construct') {
    keys(ir, ['kind', 'family', 'constructor', 'tag', 'arguments']);
    requireIR(source.arguments.length === v.fields.length && ir.arguments.length === v.fields.length,
      'constructor arity differs from source');
    for (const [i, field] of v.fields.entries()) {
      requireIR(source.arguments[i] === field.type, 'source constructor field type mismatch');
      checkArgument(ir.arguments[i], i, field.type);
    }
  } else {
    requireIR(ir.kind === 'case', 'unsupported operation');
    keys(ir, ['kind', 'family', 'constructor', 'tag', 'scrutinee', 'hit', 'miss']);
    requireIR(source.arguments[0] === family.name, 'match scrutinee has the wrong family');
    checkArgument(ir.scrutinee, 0, family.name);
    requireIR(ir.hit.length === v.fields.length + source.arguments.length - 1 &&
      ir.miss.length === source.arguments.length, 'match argument count differs from source');
    for (const [i, field] of v.fields.entries()) {
      const ref = ir.hit[i];
      keys(ref, ['kind', 'argument', 'tag', 'index', 'type']);
      requireIR(ref.kind === 'field' && ref.argument === 0 && ref.tag === v.tag &&
        ref.index === i && ref.type === field.type, 'match field order or type differs from source');
    }
    for (let i = 1; i < source.arguments.length; i++)
      checkArgument(ir.hit[v.fields.length + i - 1], i, source.arguments[i]);
    for (let i = 0; i < source.arguments.length; i++)
      checkArgument(ir.miss[i], i, source.arguments[i]);
  }
}

export function lowerConstruct(family: SumFamily, source: SumSource): ConstructIR {
  const v = variant(family, source);
  return {kind: 'construct', family: family.name, constructor: v.name, tag: v.tag,
    arguments: source.arguments.map((type, i) => argument(i, type))};
}
export function lowerCase(family: SumFamily, source: SumSource): CaseIR {
  const v = variant(family, source);
  return {kind: 'case', family: family.name, constructor: v.name, tag: v.tag,
    scrutinee: argument(0, family.name),
    hit: [...v.fields.map((f, i): Projection =>
      ({kind: 'field', argument: 0, tag: v.tag, index: i, type: f.type})),
      ...source.arguments.slice(1).map((type, i) => argument(i + 1, type))],
    miss: source.arguments.map((type, i) => argument(i, type))};
}

export function renderConstruct(family: SumFamily, source: SumSource, ir: ConstructIR, values: string[]): string {
  validateSumIR(family, source, ir);
  requireIR(ir.kind === 'construct', 'constructor renderer needs construct IR');
  requireIR(values.length === source.arguments.length, 'renderer argument count');
  return `${family.variants[ir.tag].maker}(${ir.arguments.map(a => values[a.index]).join(', ')})`;
}
export function renderCase<T extends {type: string; code: string}>(
    family: SumFamily, source: SumSource, ir: CaseIR, values: T[]) {
  validateSumIR(family, source, ir);
  requireIR(ir.kind === 'case', 'match renderer needs case IR');
  requireIR(values.length === source.arguments.length &&
    values.every((value, i) => value.type === source.arguments[i]), 'renderer argument types');
  const route = (ref: Argument | Projection): {type: string; code: string} => ref.kind === 'argument'
    ? values[ref.index]
    : {type: ref.type, code: `(${values[ref.argument].code}).as.c${ref.tag}.f${ref.index}`};
  return {condition: `(${values[ir.scrutinee.index].code}).tag == ${ir.tag}u`,
    hit: ir.hit.map(route), miss: ir.miss.map(a => values[a.index])};
}
