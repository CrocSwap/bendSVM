// These lowerings describe the pinned Base functions, not arbitrary functions
// that happen to have the same spelling. Backend checks Base provenance.
// Every wrapper evaluates each argument once. All arithmetic is unsigned.
export type Primitive = {
  args: ('U32' | 'Bool')[];
  result: 'U32' | 'Bool';
  expression: string;
};
const unary = (expression: string, result: 'U32' | 'Bool' = 'U32'): Primitive =>
  ({ args: ['U32'], result, expression });
const binary = (expression: string, result: 'U32' | 'Bool' = 'U32'): Primitive =>
  ({ args: ['U32', 'U32'], result, expression });
export const primitives: Readonly<Record<string, Primitive>> = Object.freeze({
  'U32.inc': unary('a0 + 1u'),
  'U32.add': binary('a0 + a1'),
  'U32.sub': binary('a0 - a1'),
  'U32.mul': binary('a0 * a1'),
  'U32.not': unary('~a0'),
  'U32.and': binary('a0 & a1'),
  'U32.or': binary('a0 | a1'),
  'U32.xor': binary('a0 ^ a1'),
  'U32.shl': unary('a0 << 1u'),
  'U32.shr': unary('a0 >> 1u'),
  'U32.is_eq': binary('a0 == a1', 'Bool'),
  'U32.is_ne': binary('a0 != a1', 'Bool'),
  'U32.is_lt': binary('a0 < a1', 'Bool'),
  'U32.is_le': binary('a0 <= a1', 'Bool'),
  'U32.is_gt': binary('a0 > a1', 'Bool'),
  'U32.is_ge': binary('a0 >= a1', 'Bool'),
  'U32.is_zero': unary('a0 == 0u', 'Bool'),
  // Match Base exactly; these are total operations, not checked finance APIs.
  'U32.div': binary('a1 == 0u ? 0u : a0 / a1'),
  'U32.mod': binary('a1 == 0u ? a0 : a0 % a1'),
  'U32.min': binary('a0 < a1 ? a0 : a1'),
  'U32.max': binary('a0 < a1 ? a1 : a0'),
  'Bool.not': { args: ['Bool'], result: 'Bool', expression: '!a0' },
  'Bool.and': { args: ['Bool', 'Bool'], result: 'Bool', expression: 'a0 && a1' },
  'Bool.or': { args: ['Bool', 'Bool'], result: 'Bool', expression: 'a0 || a1' },
  'Bool.xor': { args: ['Bool', 'Bool'], result: 'Bool', expression: 'a0 != a1' },
  'Bool.to_u32': { args: ['Bool'], result: 'U32', expression: 'a0' },
});
