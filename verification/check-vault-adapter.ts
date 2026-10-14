import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
// Retire success even when Python cannot start; preserve its evidence.
const receipt='build/vault-adapter-bridge/fresh-receipt.json';
if(fs.existsSync(receipt))fs.renameSync(receipt,`${receipt}.${randomUUID()}.previous`);
const child=spawnSync(process.env.PYTHON??'python3',['-B','verification/vault_adapter_bridge.py'],{stdio:'inherit'});
assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,'Vault shared-artifact bridge failed');
