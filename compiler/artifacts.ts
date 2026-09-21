import fs from 'node:fs';
import {resourceReport} from './resources.ts';
import path from 'node:path';
import type { Backend } from './backend.ts';
import { emitCodecs } from './codecs.ts';
import { emitDispatcher } from './dispatch.ts';
import { emitStorage, type StorageOptions } from './storage.ts';

export function writeArtifacts(stem: string, emitted: ReturnType<Backend['emit']>, storageRoot?: string, storageOptions?: StorageOptions) {
  // Generate everything before writing, so unsupported schemas don't leave
  // apparently complete artifacts. Public build commands must check exit status.
  const resources=resourceReport(emitted.schema);
  const codecs = emitCodecs(emitted.schema);
  const dispatch = emitDispatcher(emitted.schema);
  const storage = storageRoot === undefined ? undefined : storageOptions ? emitStorage(emitted.schema, storageRoot, storageOptions) : emitStorage(emitted.schema, storageRoot);
  const name = path.basename(stem);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Artifact basename must use letters, digits, underscore or dash');
  fs.mkdirSync(path.dirname(stem), { recursive: true });
  fs.writeFileSync(stem + '.resources.json',JSON.stringify(resources,null,2)+'\n');
  fs.writeFileSync(stem + '.h', emitted.c);
  fs.writeFileSync(stem + '.schema.json', JSON.stringify(emitted.schema, null, 2) + '\n');
  fs.writeFileSync(stem + '.wire.h', `#include "${name}.h"\n` + codecs);
  fs.writeFileSync(stem + '.dispatch.h', `#include "${name}.wire.h"\n` + dispatch);
  if (storage) {
    fs.writeFileSync(stem + '.c', `#include "${name}.wire.h"\n` + storage.c);
    fs.writeFileSync(stem + '.interface.json', JSON.stringify(storage.interface, null, 2) + '\n');
  }
}
