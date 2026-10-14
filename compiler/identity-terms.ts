import * as B from '../.deps/bend/bend2/bend.ts';

const fail = (message: string): never => { throw new Error(`Checked runtime identity: ${message}`); };
const fields: Record<string, string[]> = {
  Var: ['k','i','v'], Ref: ['k','b'], Let: ['k','i','q','v','f'], Typ: ['g'], Qnt: [], Qua: ['q'],
  Min: ['a','b'], All: ['q','k','i','A','B'], Lam: ['k','i','f','q'], App: ['f','x'],
  ADT: ['k','x','r'], Ctr: ['k','x'], Mat: ['k','h','m'], Efq: [], Eql: ['a','b','T'],
  Rfl: [], Rwt: ['e','p','f'], Ann: ['x','T'],
};
function object(value: unknown): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid term object');
  if (Object.getOwnPropertySymbols(value).length) fail('symbol term property');
  for (const d of Object.values(Object.getOwnPropertyDescriptors(value)))
    if (d.get || d.set || !d.enumerable) fail('accessor or hidden term property');
}
// Reject sparse arrays and executable or hidden array properties before iteration.
export function identityArray(value: unknown): any[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail('invalid term array');
  if (Object.getOwnPropertySymbols(value).length) fail('symbol array property');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1) fail('sparse or extended term array');
  for (let i = 0; i < value.length; i++) {
    const d = descriptors[String(i)];
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail('accessor or sparse term array');
  }
  return value;
}
function quant(value: unknown, optional = false) {
  if (optional && value === undefined) return;
  object(value);
  if (!['None','Lone','Many'].includes(value.$) || Object.keys(value).some(k => k !== '$')) fail('invalid quantity');
}
function name(value: unknown) { if (typeof value !== 'string') fail('invalid term name'); }
function index(value: unknown) { if (!Number.isSafeInteger(value)) fail('invalid term index'); }

// Mirrors the pinned term_lower operations with validation, explicit forcing,
// cycle/depth/work limits and sharing. Checker-produced closures are trusted
// to be parametric and terminating; arbitrary JS closures are not a supported input.
export class IdentityTermLower {
  private count = 0;
  private active = new Set<object>();
  private cache = new WeakMap<object, Map<number, B.LTerm>>();
  // Open memos can contain free context variables. One lowering at depth zero
  // can identify such a variable with a new binder. The ordered pair at two
  // distinct depths distinguishes them: free indices stay fixed, whereas every
  // introduced binder index shifts by one. This relies on the same parametric
  // checker-closure assumption as ordinary lowering, not arbitrary JavaScript.
  lowerOpen(value: unknown): [B.LTerm, B.LTerm] {
    return [this.lower(value, 0), this.lower(value, 1)];
  }
  lower(value: unknown, d = 0, depth = 0): B.LTerm {
    if (depth > 512) fail('lowering depth limit');
    object(value);
    if (this.active.has(value)) fail('cyclic higher-order term');
    const cached = this.cache.get(value)?.get(d);
    if (cached) return cached;
    if (++this.count > 1_000_000) fail('lowering work limit');
    if (typeof value.$ !== 'string' || !Object.hasOwn(fields, value.$)) fail(`unsupported term kind ${String(value.$)}`);
    if (Object.keys(value).some(k => k !== '$' && k !== 's' && !fields[value.$].includes(k))) fail('unknown term field');
    const t = value as any;
    this.active.add(value);
    const sub = (child: unknown, level = d) => this.lower(child, level, depth + 1);
    const array = identityArray;
    const invoke = (f: unknown, arg: unknown) => {
      if (typeof f !== 'function') fail('expected checker binder closure');
      return f(arg);
    };
    let result: B.LTerm;
    try {
      switch (t.$) {
        case 'Var':
          name(t.k); index(t.i);
          result = t.v !== undefined ? sub(t.v) : B.Var(t.k,t.i,t.s); break;
        case 'Ref':
          name(t.k); if(t.b !== undefined && typeof t.b !== 'boolean') fail('invalid primitive flag');
          result = B.Ref(t.k,t.s,t.b); break;
        case 'Let': {
          const names = array(t.k), values = array(t.v); names.forEach(name);
          array(t.i).forEach(index); array(t.q).forEach(q => quant(q));
          if(names.length !== values.length || t.i.length !== names.length || t.q.length !== names.length) fail('let arity mismatch');
          const xs = names.map((k,j) => B.Var(k,d+j));
          result = B.Let(names,xs.map((_,j)=>d+j),values.map(v=>sub(v)),sub(invoke(t.f,xs),d+names.length),t.s,t.q); break;
        }
        case 'Typ': result=B.Typ(sub(t.g),t.s); break;
        case 'Qnt': result=B.Qnt(t.s); break;
        case 'Qua': quant(t.q); result=B.Qua(t.q,t.s); break;
        case 'Min': result=B.Min(sub(t.a),sub(t.b),t.s); break;
        case 'All':
          name(t.k); index(t.i); quant(t.q);
          result=B.All(t.q,t.k,d,sub(t.A),sub(invoke(t.B,B.Var(t.k,d)),d+1),t.s); break;
        case 'Lam':
          name(t.k); index(t.i); quant(t.q,true);
          result=B.Lam(t.k,d,sub(invoke(t.f,B.Var(t.k,d)),d+1),t.s,t.q); break;
        case 'App': result=B.App(sub(t.f),sub(t.x),t.s); break;
        case 'ADT':
          name(t.k); array(t.r).forEach(name);
          result=B.ADT(t.k,array(t.x).map(x=>sub(x)),t.s,t.r); break;
        case 'Ctr': name(t.k); result=B.Ctr(t.k,array(t.x).map(x=>sub(x)),t.s); break;
        case 'Mat': name(t.k); result=B.Mat(t.k,sub(t.h),sub(t.m),t.s); break;
        case 'Efq': result=B.Efq(t.s); break;
        case 'Eql': result=B.Eql(sub(t.a),sub(t.b),sub(t.T),t.s); break;
        case 'Rfl': result=B.Rfl(t.s); break;
        case 'Rwt': result=B.Rwt(sub(t.e),sub(t.p),sub(t.f),t.s); break;
        case 'Ann': result=B.Ann(sub(t.x),sub(t.T),t.s); break;
        default: return fail('unsupported term');
      }
    } finally { this.active.delete(value); }
    let map=this.cache.get(value); if(!map){map=new Map();this.cache.set(value,map);} map.set(d,result);
    return result;
  }
}
