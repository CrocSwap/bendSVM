import * as B from '../.deps/bend/bend2/bend.ts';
import path from 'node:path';
import fs from 'node:fs';
import { TargetDiagnostic, targetError } from './diagnostics.ts';
import { primitives } from './primitives.ts';
import type { RuntimeSchema } from './schema.ts';

export const mangle = (name: string) => 'bend_' + name.replace(/[^a-zA-Z0-9]/g,
  c => '_' + c.charCodeAt(0).toString(16) + '_');
const fail = (message: string): never => { throw targetError(message); };
type Term = B.LTerm;
type Value = { code: string; type: string; descent?: { argument: number; depth: number } };
type Loop = { name: string; fuel: number; used: boolean };
type Field = { name: string; type: string };
type Variant = { name: string; tag: number; fields: Field[]; type: string; sourceName?: string };
type Signature = { args: string[]; result: string };

export async function checkedBook(file: string): Promise<B.Book> {
  return (await checkedProgram(file)).book;
}

export async function checkedProgram(file: string): Promise<{ book: B.Book; files: string[] }> {
  const files: string[] = [];
  try { return {book: await loadCheckedBook(file, files), files}; }
  catch (e) { throw new Error(describeError(e)); }
}

async function loadCheckedBook(file: string, files: string[]): Promise<B.Book> {
  const book = B.book_nil();
  const seen = new Map<string, string | null>();
  await B.book_load(book, path.resolve(file), '', seen);
  const laws = path.join(path.dirname(path.resolve(file)), 'LAWS.bend');
  if (path.basename(file) === 'PROOF.bend' && fs.existsSync(laws) && !seen.has(fs.realpathSync(laws))) {
    fail('PROOF.bend must import the adjacent LAWS.bend');
  }
  B.book_valid(book);
  if (book.hols || book.open) fail('Unresolved proof holes or open laws');
  // Unlike the upstream CLI warning, unsafe/foreign dependencies are errors.
  // Inspect specifications as well as implementations, including base dependencies.
  const visited = new Set<string>();
  const scan = (term: unknown) => {
    if (!term || typeof term !== 'object') return;
    const t = term as { $?: string; k?: string };
    if (['Ref', 'ADT', 'Ctr', 'Mat'].includes(t.$ ?? '') && t.k) visit(t.k);
    for (const [k, value] of Object.entries(term)) if (k !== 's') scan(value);
  };
  const visit = (name: string) => {
    if (visited.has(name)) return;
    visited.add(name);
    const t = book.tlds[name];
    if (!t) {
      const ctr = book.ctrs[name];
      if (ctr) scan(B.term_lower(ctr.T));
      return;
    }
    if (t.$ === 'Def' && (t.u || t.i)) fail(`Unsafe/foreign dependency: ${name}`);
    scan(B.term_lower(t.T));
    if (t.$ === 'Def' && t.v) scan(B.term_lower(t.v));
    if (t.$ === 'ADT') t.c.forEach(c => scan(B.term_lower(c.T)));
  };
  for (const [name, t] of Object.entries(book.tlds)) if (!t.b) visit(name);
  files.push(...seen.keys());
  return book;
}

// A deliberately small, fail-closed backend over Bend's checked elaboration.
// Proof definitions are checked above but never reachable from the export roots.
export class Backend {
  private types = new Map<string, Variant[]>();
  private nativeSizes = new Map<string,number>([['U32',4],['Bool',4],['Nat',4]]);
  private typeBusy = new Set<string>();
  private signatures = new Map<string, Signature>();
  private functionBusy = new Set<string>();
  private definitions: string[] = [];
  private declarations: string[] = [];
  private serial = 0;
  private usesNat = false;
  private roots = new Set<string>();
  constructor(private book: B.Book) {}

  private bare(t: Term): Term {
    while (t.$ === 'Ann') t = t.x;
    return t;
  }
  private type(t: Term): string {
    t = this.bare(t);
    // Checker annotations can contain memo cells holding higher-order types.
    // Force only type terms; runtime expressions must retain their checked form.
    if (t.$ === 'Var' && t.v !== undefined)
      t = this.bare(B.term_lower(B.term_wnf(this.book, t.v as B.HTerm)));
    if (t.$ !== 'Ref' && t.$ !== 'ADT') return fail(`Unsupported runtime type: ${t.$}`);
    const sourceName = t.k;
    const parameters = t.$ === 'ADT' ? t.x : [];
    if (this.typeBusy.size >= 64) fail('Runtime type specialization limit exceeded');
    const arguments_ = parameters.map(p => this.type(p));
    const name = arguments_.length ? `${sourceName}<${arguments_.join(',')}>` : sourceName;
    if (name === 'U32' || name === 'Bool' || name === 'Nat') {
      if (name === 'Nat') this.usesNat = true;
      if (!this.book.tlds[name]?.b) fail(`Primitive ${name} must come from pinned Base`);
      return name;
    }
    if (this.types.has(name)) return name;
    if (this.types.size >= 256) fail('Runtime type specialization limit exceeded');
    if (this.typeBusy.has(name)) fail(`Recursive data type is unsupported: ${name}`);
    const tld = this.book.tlds[sourceName];
    if (!tld || tld.$ !== 'ADT' || tld.n !== parameters.length || !tld.c.length) {
      return fail(`Expected a concrete nonempty data type: ${name}`);
    }
    this.typeBusy.add(name);
    const variants = tld.c.map((c, tag) => {
      let specialized = c.T;
      for (const parameter of parameters) {
        const head = B.term_wnf(this.book, specialized);
        if (head.$ !== 'All' || head.q.$ !== 'None' || B.term_wnf(this.book, head.A).$ !== 'Typ')
          fail(`Only erased type parameters are supported: ${sourceName}`);
        specialized = head.B(B.term_higher(parameter));
      }
      let T = B.term_lower(specialized);
      const fields: Field[] = [];
      while (T.$ === 'All') {
        if (T.q.$ === 'None') fail('Erased/dependent runtime fields are unsupported');
        fields.push({ name: T.k, type: this.type(T.A) });
        T = T.B;
      }
      return { name: arguments_.length ? `${c.k}<${arguments_.join(',')}>` : c.k,
        ...(arguments_.length ? {sourceName:c.k} : {}), tag, fields, type: name };
    });
    this.types.set(name, variants);
    this.typeBusy.delete(name);
    const nativeBytes=4+Math.max(...variants.map(v=>v.fields.length?v.fields.reduce((n,f)=>n+this.nativeSizes.get(f.type)!,0):4));
    this.nativeSizes.set(name,nativeBytes);
    if(nativeBytes>1536)throw new TargetDiagnostic('BEND-SBF202', `Bend value exceeds SBF subset size limit: ${name} (${nativeBytes} native bytes; limit 1536)`, 'Reduce the bounded window or record size; account capacity can remain large.');
    const ct = this.ctype(name);
    this.declarations.push(`typedef struct {\n  bend_u32 tag;\n  union {\n${variants.map(v =>
      `    struct { ${v.fields.map((f, i) => `${this.ctype(f.type)} f${i};`).join(' ') || 'bend_u32 unused;'} } c${v.tag};`
    ).join('\n')}\n  } as;\n} ${ct};\n_Static_assert(sizeof(${ct}) <= 1536, "Bend value exceeds SBF subset size limit");`);
    for (const v of variants) this.declarations.push(
      `static inline ${ct} ${mangle(v.name)}_make(${v.fields.map((f, i) => `${this.ctype(f.type)} a${i}`).join(', ') || 'void'}) {\n` +
      `  return (${ct}){ .tag = ${v.tag}, .as.c${v.tag} = { ${v.fields.map((_, i) => `.f${i} = a${i}`).join(', ') || '.unused = 0'} } };\n}`);
    return name;
  }
  private ctype(type: string): string {
    return type === 'U32' || type === 'Bool' || type === 'Nat' ? 'bend_u32' : mangle(type) + '_t';
  }
  private variant(name: string, family?: string): Variant {
    if (name === 'False' || name === 'True') return {
      name, tag: Number(name === 'True'), fields: [], type: 'Bool'
    };
    if (family) return this.types.get(family)?.find(v => (v.sourceName ?? v.name) === name)
      ?? fail(`Constructor ${name} does not belong to ${family}`);
    const ctr = this.book.ctrs[name] ?? fail(`Unknown constructor ${name}`);
    let T = B.term_lower(ctr.T);
    while (T.$ === 'All') T = T.B;
    const concrete = this.type(T);
    return this.types.get(concrete)?.find(v => v.name === name) ?? fail(`Unsupported constructor ${name}`);
  }
  private signature(name: string): Signature {
    if (this.signatures.has(name)) return this.signatures.get(name)!;
    const def = this.book.tlds[name];
    if (!def || def.$ !== 'Def' || def.x || !def.e || def.u || def.i) {
      return fail(`Unsupported runtime function ${name}`);
    }
    if (def.b && !primitives[name]) fail(`Base runtime function is not whitelisted: ${name}`);
    if (primitives[name] && !def.b) fail(`Primitive ${name} must come from pinned Base`);
    let T = B.term_lower(def.T);
    const args: string[] = [];
    while (T.$ === 'All') {
      if (T.q.$ === 'None') fail('Erased runtime parameters are unsupported');
      args.push(this.type(T.A));
      T = T.B;
    }
    if (args.length > 8) fail('At most eight runtime arguments are supported');
    const signature = { args, result: this.type(T) };
    const primitive = primitives[name];
    if (primitive && (JSON.stringify(args) !== JSON.stringify(primitive.args) || signature.result !== primitive.result)) {
      fail(`Primitive signature changed: ${name}`);
    }
    this.signatures.set(name, signature);
    return signature;
  }
  private assertType(v: Value, expected: string) {
    if (v.type !== expected) fail(`Backend type mismatch: ${v.type} vs ${expected}`);
  }
  private expr(term: Term, env: Map<number, Value>, lines: string[]): Value {
    const t = this.bare(term);
    if (t.$ === 'Var') return env.get(t.i) ?? fail(`Unbound runtime variable ${t.k}`);
    if (t.$ === 'Ctr') {
      if (t.k === 'Zero' || t.k === 'Succ') {
        this.type({$: 'Ref', k: 'Nat'} as Term);
        let n=0, cursor=t as Term;
        while (true) {
          cursor=this.bare(cursor);
          if(cursor.$==='Ctr' && cursor.k==='Zero' && !cursor.x.length) break;
          if(cursor.$!=='Ctr' || cursor.k!=='Succ' || cursor.x.length!==1)
            fail('Runtime Nat construction is unsupported; use a bounded literal or predecessor');
          if(++n>64) fail('Nat literal exceeds bounded fuel limit 64');
          cursor=cursor.x[0];
        }
        return {type:'Nat',code:`${n}u`};
      }
      if (t.k === 'U32') {
        const n = B.u32_from_term(B.term_higher(t));
        if (n === null) fail('Only literal U32 constructors are supported');
        return { code: `${n}u`, type: 'U32' };
      }
      const annotation = term.$ === 'Ann' ? term.T : undefined;
      const variant = this.variant(t.k, annotation ? this.type(annotation) : undefined);
      if (t.x.length !== variant.fields.length) fail(`Constructor arity: ${t.k}`);
      const args = t.x.map(x => this.expr(x, env, lines));
      args.forEach((v, i) => this.assertType(v, variant.fields[i].type));
      return { type: variant.type, code: variant.type === 'Bool' ? `${variant.tag}u`
        : `${mangle(variant.name)}_make(${args.map(v => v.code).join(', ')})` };
    }
    if (t.$ === 'App' || t.$ === 'Ref') {
      const xs: Term[] = [];
      let head = t;
      while (head.$ === 'App') { xs.unshift(head.x); head = this.bare(head.f) as typeof head; }
      if (head.$ !== 'Ref') return fail('Only direct, fully applied calls are supported');
      const args = xs.map(x => this.expr(x, env, lines));
      return this.call(head.k, args);
    }
    if (t.$ === 'Let') {
      if (t.q.some(q => q.$ === 'None')) fail('Erased local bindings are unsupported');
      const values = t.v.map(v => this.expr(v, env, lines));
      const next = new Map(env);
      values.forEach((v, i) => {
        const code = `v${this.serial++}`;
        lines.push(`${this.ctype(v.type)} ${code} = ${v.code};`);
        next.set(t.i[i], { ...v, code });
      });
      return this.expr(t.f, next, lines);
    }
    return fail(`Unsupported runtime expression ${t.$}`);
  }
  private call(name: string, args: Value[]): Value {
    const sig = this.signature(name);
    if (args.length !== sig.args.length) fail(`Partial/over-applied call to ${name}`);
    args.forEach((v, i) => this.assertType(v, sig.args[i]));
    this.emitFunction(name);
    return { type: sig.result, code: `${mangle(name)}(${args.map(v => v.code).join(', ')})` };
  }
  private body(term: Term, args: Value[], env: Map<number, Value>, result: string, loop: Loop): string[] {
    const t = this.bare(term);
    if (t.$ === 'Lam') {
      if (!args.length || t.q?.$ === 'None') fail('Unsupported lambda/erased argument');
      const next = new Map(env); next.set(t.i, args[0]);
      return this.body(t.f, args.slice(1), next, result, loop);
    }
    if (t.$ === 'Mat') {
      const [scrutinee, ...rest] = args;
      if (!scrutinee) return fail('Unapplied match');
      if(scrutinee.type==='Nat') {
        if(t.k!=='Zero' && t.k!=='Succ') fail('Invalid Nat match');
        const fields:Value[]=t.k==='Zero'?[]:[{type:'Nat',code:`(${scrutinee.code} - 1u)`,
          ...(scrutinee.descent?{descent:{argument:scrutinee.descent.argument,depth:scrutinee.descent.depth+1}}:{})}];
        const condition=t.k==='Zero'?`${scrutinee.code} == 0u`:`${scrutinee.code} != 0u`;
        return [`if (${condition}) {`, ...this.body(t.h,[...fields,...rest],env,result,loop).map(l=>'  '+l),
          '} else {',...this.body(t.m,args,env,result,loop).map(l=>'  '+l),'}'];
      }
      const v = this.variant(t.k, scrutinee.type);
      this.assertType(scrutinee, v.type);
      const fields = v.fields.map((f, i) => ({ type: f.type,
        code: `(${scrutinee.code}).as.c${v.tag}.f${i}` }));
      const tag = v.type === 'Bool' ? scrutinee.code : `(${scrutinee.code}).tag`;
      return [`if (${tag} == ${v.tag}u) {`,
        ...this.body(t.h, [...fields, ...rest], env, result, loop).map(l => '  ' + l),
        '} else {', ...this.body(t.m, args, env, result, loop).map(l => '  ' + l), '}'];
    }
    // Only possible after exhausting a checked match on valid typed data.
    // The external adapter must validate tags before constructing typed values.
    if (t.$ === 'Efq') return ['__builtin_unreachable();'];
    const lines: string[] = [];
    let head=t; const xs:Term[]=[];
    while(head.$==='App') {xs.unshift(head.x);head=this.bare(head.f);}
    if(head.$==='Ref' && head.k===loop.name) {
      const values=xs.length?xs.map(x=>this.expr(x,env,lines)):args;
      const sig=this.signature(loop.name);
      if(values.length!==sig.args.length) fail('Partial recursive call');
      values.forEach((v,i)=>this.assertType(v,sig.args[i]));
      const fuel=values[loop.fuel]?.descent;
      if(loop.fuel<0 || !fuel || fuel.argument!==loop.fuel || fuel.depth<1)
        fail('Recursive tail call must decrease the same Nat fuel argument');
      loop.used=true;
      const temps=values.map(v=>{const name=`next${this.serial++}`;
        lines.push(`${this.ctype(v.type)} ${name} = ${v.code};`);return name;});
      temps.forEach((name,i)=>lines.push(`a${i} = ${name};`));
      return [...lines,'continue;'];
    }
    const value = args.length && t.$ === 'Ref' ? this.call(t.k, args)
      : args.length ? fail('Unsupported function-valued expression') : this.expr(term, env, lines);
    this.assertType(value, result);
    return [...lines, `return ${value.code};`];
  }
  private emitted = new Set<string>();
  private emitFunction(name: string) {
    if (this.functionBusy.has(name)) fail(`Recursion is unsupported: ${name}`);
    if (this.emitted.has(name)) return;
    this.functionBusy.add(name);
    try {
    const sig = this.signature(name);
    const def = this.book.tlds[name] as B.Def;
    const args:Value[] = sig.args.map((type, i) => ({ type, code: `a${i}`,
      ...(type==='Nat'?{descent:{argument:i,depth:0}}:{}) }));
    const loop:Loop={name,fuel:sig.args.indexOf('Nat'),used:false};
    const primitive = primitives[name];
    let body = primitive ? [`return (bend_u32)(${primitive.expression});`]
      : this.body(def.e!, args, new Map(), sig.result, loop);
    if(loop.used) body=['for (;;) {',...body.map(l=>'  '+l),'}'];
    // Affine Bend functions may discard inputs. Keep freestanding -Werror
    // builds valid even when a parameter is absent from the lowered body.
    body.unshift(...args.map(a => `(void)${a.code};`));
    this.definitions.push(`static ${loop.used || this.roots.has(name) ? '__attribute__((noinline))' : 'inline'} ${this.ctype(sig.result)} ${mangle(name)}(${args.map(a =>
      `${this.ctype(a.type)} ${a.code}`).join(', ') || 'void'}) {\n${body.map(l => '  ' + l).join('\n')}\n}`);
    this.functionBusy.delete(name); this.emitted.add(name);
    } catch(e) { if(e instanceof TargetDiagnostic)e.inFunction(name); throw e; }
  }
  emit(roots: string[]): { c: string; functions: string[]; schema: RuntimeSchema } {
    this.roots = new Set(roots);
    roots.forEach(name => this.emitFunction(name));
    const schema: RuntimeSchema = { version: 1, types: [
      { kind: 'u32', name: 'U32', cType: 'bend_u32' },
      { kind: 'bool', name: 'Bool', cType: 'bend_u32' },
      ...(this.usesNat ? [{kind:'u32' as const,name:'Nat',cType:'bend_u32',max:64}] : []),
      ...[...this.types].map(([name, variants]) => ({ kind: 'adt' as const, name, cType: this.ctype(name),
        variants: variants.map(v => ({ name: v.name, tag: v.tag, fields: v.fields,
          cMaker: mangle(v.name) + '_make', ...(v.sourceName ? {sourceName:v.sourceName} : {}) })) })),
    ], exports: roots.map(name => ({ name, cName: mangle(name), ...this.signature(name) })) };
    return { c: ['/* Generated from checked Bend terms. Do not edit. */',
      '#pragma once', 'typedef unsigned int bend_u32;',
      '_Static_assert(sizeof(bend_u32) == 4, "Requires 32-bit unsigned int");',
      ...this.declarations, ...this.definitions, ''].join('\n\n'), functions: [...this.emitted], schema };
  }
}

export function describeError(e: unknown): string {
  return (e as B.Err)?.$ === 'Err' ? B.err_show(e as B.Err) : String(e);
}
