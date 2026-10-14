import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dir,'..');
const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest=path.join(root,'scripts/test-runner/Cargo.toml');
function sources():string[] {
  function files(directory:string):string[] {
    return fs.readdirSync(directory).sort().flatMap(name=>{
      const file=path.join(directory,name),stat=fs.lstatSync(file);
      assert(!stat.isSymbolicLink(),'runner source must be a regular file or directory');
      return stat.isDirectory()?files(file):[file];
    });
  }
  return [import.meta.path,manifest,path.join(root,'scripts/test-runner/Cargo.lock'),
    ...files(path.join(root,'scripts/test-runner/src'))].sort();
}
export type ShaRunnerReceipt={
  passed:true; executable:{path:string;sha256:string}; sourceHashes:Record<string,string>;
  toolHashes:Record<string,string>; evidenceHashes:Record<string,string>; cargoArgs:string[];
  rustcVersion:string; cargoVersion:string; runtime:'LiteSVM 0.7.1';
};
export function verifyShaRunner(receipt:ShaRunnerReceipt):void {
  assert.equal(receipt.passed,true);
  assert.equal(receipt.runtime,'LiteSVM 0.7.1');
  assert.deepEqual(Object.keys(receipt.sourceHashes).sort(),sources(),'runner source inventory changed');
  for(const bindings of [receipt.sourceHashes,receipt.toolHashes,receipt.evidenceHashes])
    for(const [file,digest] of Object.entries(bindings))assert.equal(hash(file),digest,'runner input changed: '+file);
  assert.equal(hash(receipt.executable.path),receipt.executable.sha256,'retained runner bytes changed');
}
export function prepareShaRunner(directory:string):{receipt:ShaRunnerReceipt;file:string} {
  fs.mkdirSync(directory,{recursive:false});
  const sourceHashes=Object.fromEntries(sources().map(file=>[file,hash(file)]));
  function command(executable:string,args:string[],name:string) {
    const result=spawnSync(executable,args,{cwd:root,encoding:'utf8',timeout:900000,
      maxBuffer:32*1024*1024,env:{...process.env,RUSTC:rustcPath,CARGO_NET_OFFLINE:'true'}});
    fs.writeFileSync(path.join(directory,name+'.stdout'),result.stdout??'');
    fs.writeFileSync(path.join(directory,name+'.stderr'),result.stderr??'');
    assert.ifError(result.error);assert.equal(result.signal,null);
    assert.equal(result.status,0,name+': '+result.stderr);
    return result.stdout.trim();
  }
  // Resolve the installed host toolchain before invoking Cargo; the platform
  // SBF Rust compiler remains separately checked by the image tests.
  const sysroot=spawnSync('rustc',['--print','sysroot'],{cwd:root,encoding:'utf8'});
  assert.ifError(sysroot.error);assert.equal(sysroot.status,0,sysroot.stderr);
  const rustcPath=fs.realpathSync(path.join(sysroot.stdout.trim(),'bin/rustc'));
  const cargoPath=fs.realpathSync(path.join(sysroot.stdout.trim(),'bin/cargo'));
  const toolHashes={[rustcPath]:hash(rustcPath),[cargoPath]:hash(cargoPath)};
  const rustcVersion=command(rustcPath,['--version','--verbose'],'rustc-version');
  const cargoVersion=command(cargoPath,['--version','--verbose'],'cargo-version');
  const metadata=JSON.parse(command(cargoPath,['metadata','--offline','--locked','--format-version','1',
    '--manifest-path',manifest],'metadata'));
  const packageId=metadata.resolve.root;
  const packageInfo=metadata.packages.find((p:any)=>p.id===packageId);
  assert.equal(packageInfo?.name,'bend-test-runner');
  assert.equal(fs.realpathSync(packageInfo.manifest_path),fs.realpathSync(manifest));
  const runtime=metadata.packages.filter((p:any)=>p.name==='litesvm');
  assert.equal(runtime.length,1);assert.equal(runtime[0].version,'0.7.1');
  const cargoArgs=['build','--offline','--locked','--manifest-path',manifest,
    '--target-dir',path.join(root,'scripts/test-runner/target'),'--bin','bend-test-runner','--message-format=json'];
  const messages=command(cargoPath,cargoArgs,'build').split('\n').map(line=>JSON.parse(line));
  const artifacts=messages.filter(m=>m.reason==='compiler-artifact'&&m.package_id===packageId&&
    m.target.name==='bend-test-runner'&&m.target.kind.includes('bin')&&typeof m.executable==='string');
  assert.equal(artifacts.length,1,'Cargo identifies exactly one built runner executable');
  assert(messages.some(m=>m.reason==='build-finished'&&m.success===true));
  const built=artifacts[0].executable,builtSha256=hash(built);
  const selected=process.env.SHA256_SHORT_SBF_RUNNER?path.resolve(process.env.SHA256_SHORT_SBF_RUNNER):built;
  assert.equal(hash(selected),builtSha256,'runner override must match the freshly built executable');
  const executable=path.join(directory,'bend-test-runner');
  fs.copyFileSync(selected,executable,fs.constants.COPYFILE_EXCL);fs.chmodSync(executable,0o755);
  assert.equal(hash(built),builtSha256,'built runner changed during capture');
  assert.equal(hash(selected),builtSha256,'selected runner changed during capture');
  assert.equal(hash(executable),builtSha256);
  const hello=spawnSync(executable,[],{cwd:root,input:'{"op":"hello"}\n',encoding:'utf8',timeout:30000});
  fs.writeFileSync(path.join(directory,'hello.stdout'),hello.stdout??'');
  fs.writeFileSync(path.join(directory,'hello.stderr'),hello.stderr??'');
  assert.ifError(hello.error);assert.equal(hello.status,0,hello.stderr);
  const response=JSON.parse(hello.stdout.trim());assert.equal(response.success,true);
  assert.equal(response.value.runtime,'LiteSVM 0.7.1');
  const evidenceHashes=Object.fromEntries(fs.readdirSync(directory).filter(n=>n!=='bend-test-runner')
    .map(name=>{const file=path.join(directory,name);return [file,hash(file)];}));
  const receipt:ShaRunnerReceipt={passed:true,executable:{path:executable,sha256:builtSha256},
    sourceHashes,toolHashes,evidenceHashes,cargoArgs,rustcVersion,cargoVersion,runtime:'LiteSVM 0.7.1'};
  verifyShaRunner(receipt);
  const file=path.join(directory,'receipt.json');fs.writeFileSync(file,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  return {receipt,file};
}
