import crypto from 'node:crypto';

// The checked SDK source proved by verify:division and verify:multiplication.
// A source edit disables these lowerings until its proof and this digest are
// reviewed together. The ordinary Bend lowering remains the fallback.
export const checkedMathSourceSha256 = '5ad6a66f8f6675f06469d4a8e9d4426cd6e4ac81b2cb1e278462565b42e59b7b';

type Signature = {args:string[];result:string};
type Mangle = (name:string) => string;

function checkedModuleSource(term: unknown): string | undefined {
  if (!term || typeof term !== 'object') return undefined;
  const node = term as Record<string,unknown>;
  const span = node.s as {src?:unknown} | undefined;
  if (typeof span?.src === 'string') return span.src;
  for (const [key,value] of Object.entries(node)) {
    if (key === 's') continue;
    const source = checkedModuleSource(value);
    if (source !== undefined) return source;
  }
  return undefined;
}

export function nativeArithmeticBody(name: string, signature: Signature,
    checkedBody: unknown, mangle: Mangle): string[] | undefined {
  const functionName = name.endsWith('/sdk/math.divmod') || name === 'divmod' ? 'divmod'
    : name.endsWith('/sdk/math.mul32') || name === 'mul32' ? 'mul32' : undefined;
  if (!functionName) return undefined;
  const source = checkedModuleSource(checkedBody);
  if (!source || crypto.createHash('sha256').update(source).digest('hex') !== checkedMathSourceSha256)
    return undefined;
  const prefix = name.slice(0, -functionName.length);
  const u64 = prefix + 'U64';
  if (functionName === 'mul32') {
    if (signature.result !== u64 || signature.args.join(',') !== 'U32,U32') return undefined;
    return [
      '_Static_assert(sizeof(unsigned long long) == 8, "Requires 64-bit unsigned long long");',
      'unsigned long long product = (unsigned long long)a0 * (unsigned long long)a1;',
      `return ${mangle(u64)}_make((bend_u32)product, (bend_u32)(product >> 32));`,
    ];
  }
  if (signature.result !== prefix + 'DivResult' ||
      signature.args.join(',') !== `${u64},${u64}`) return undefined;
  return [
    '_Static_assert(sizeof(unsigned long long) == 8, "Requires 64-bit unsigned long long");',
    'if (a0.tag != 0u || a1.tag != 0u) __builtin_unreachable();',
    'unsigned long long n = ((unsigned long long)a0.as.c0.f1 << 32) | a0.as.c0.f0;',
    'unsigned long long d = ((unsigned long long)a1.as.c0.f1 << 32) | a1.as.c0.f0;',
    `if (!d) return ${mangle(prefix + 'DivErr')}_make(3u);`,
    'unsigned long long q = n / d;',
    'unsigned long long r = n % d;',
    `return ${mangle(prefix + 'DivOk')}_make(${mangle(prefix + 'Division')}_make(`,
    `  ${mangle(u64)}_make((bend_u32)q, (bend_u32)(q >> 32)),`,
    `  ${mangle(u64)}_make((bend_u32)r, (bend_u32)(r >> 32))));`,
  ];
}
