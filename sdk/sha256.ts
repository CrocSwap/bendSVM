import {createHash} from 'node:crypto';

export const SHA256_MAX_SLICES = 16;
export const SHA256_MAX_BYTES = 1024;
export const SHA256_DIGEST_BYTES = 32;

export type Sha256Error =
  | 'invalid-arguments'
  | 'too-many-slices'
  | 'too-many-bytes'
  | 'hash-failure';

export type Sha256Result =
  | {readonly ok: true; readonly digest: Uint8Array}
  | {readonly ok: false; readonly error: Sha256Error};

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const viewAt = typedArrayPrototype.at;
const viewBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const viewOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const viewLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;

const failure = (error: Sha256Error): Sha256Result => ({ok: false, error});

/**
 * Hash the concatenation of at most 16 immutable byte views and 1,024 total
 * bytes. Part boundaries are not encoded. Inputs are borrowed and never
 * modified; callers must keep them unchanged for this synchronous call.
 * Returns the raw 32 digest bytes in SHA-256 output order.
 */
export function sha256(parts: readonly Uint8Array[]): Sha256Result {
  let views: Uint8Array[];
  try {
    if (!Array.isArray(parts)) return failure('invalid-arguments');
    const count = parts.length;
    if (!Number.isSafeInteger(count) || count < 0) return failure('invalid-arguments');
    if (count > SHA256_MAX_SLICES) return failure('too-many-slices');

    let totalBytes = 0;
    views = [];
    for (let i = 0; i < count; ++i) {
      const part = parts[i];
      if (!(part instanceof Uint8Array) || !ArrayBuffer.isView(part))
        return failure('invalid-arguments');
      // Validate the original view, whose intrinsic size becomes zero when
      // a resizable buffer shrinks it out of bounds. Valid empty views pass.
      viewAt.call(part, 0);
      const buffer = viewBuffer.call(part);
      if (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer)
        return failure('invalid-arguments');
      // Creating a view rejects detached buffers, including detached empty
      // views, without relying on the optional ArrayBuffer.detached property.
      // Intrinsic getters ignore user-defined byteLength/buffer overrides.
      const view = new Uint8Array(buffer, viewOffset.call(part), viewLength.call(part));
      if (view.byteLength > SHA256_MAX_BYTES - totalBytes)
        return failure('too-many-bytes');
      totalBytes += view.byteLength;
      views.push(view);
    }
  } catch {
    return failure('invalid-arguments');
  }

  try {
    const hash = createHash('sha256');
    for (const part of views) hash.update(part);
    const digest = hash.digest();
    if (digest.byteLength !== SHA256_DIGEST_BYTES) return failure('hash-failure');
    return {ok: true, digest: new Uint8Array(digest)};
  } catch {
    return failure('hash-failure');
  }
}
