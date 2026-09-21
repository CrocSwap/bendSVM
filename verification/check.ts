import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { prepareBend, BEND_COMMIT } from '../scripts/build.ts';

prepareBend();
const {model}=await import('./model.ts');
const B=await import('../.deps/bend/bend2/bend.ts');
const {checkedBook}=await import('../compiler/backend.ts');
fs.mkdirSync('build',{recursive:true});
const roots=['add','sub','less','equal'];
async function run(source:string,stem:string,expected:number) {
  const program=await model(source,roots);
  fs.writeFileSync(stem+'.model.json',JSON.stringify(program)+'\n');
  const result=spawnSync(process.env.PYTHON??'python3',['verification/prove.py',stem+'.model.json'],{encoding:'utf8'});
  assert.equal(result.status,expected,result.stderr||result.stdout);
  const report=JSON.parse(result.stdout);
  if(expected===0) assert.ok(report.claims.every((c:any)=>c.result==='unsat'));
  else {
    assert.ok(report.claims.some((c:any)=>c.result==='sat'),'Mutations require a counterexample, not timeout');
    const book=await checkedBook(source);
    const max=(1n<<64n)-1n;
    const arg=(n:bigint)=>B.Ctr('U64',[B.term_higher(B.u32_to_term(Number(n&0xffffffffn))),B.term_higher(B.u32_to_term(Number(n>>32n)))]);
    for(const claim of report.claims.filter((c:any)=>c.result==='sat')) {
      const a=BigInt(claim.counterexample.a),b=BigInt(claim.counterexample.b);
      const result=B.term_snf(book,B.App(B.App(B.Ref(claim.function),arg(a)),arg(b)));
      assert.equal(result.$,'Ctr');if(result.$!=='Ctr') throw new Error('Expected evaluated constructor');
      let actual:unknown,expected:unknown;
      if(claim.function==='less'||claim.function==='equal') {
        actual=result.k==='True';expected=claim.function==='less'?a<b:a===b;
      } else {
        if(result.k==='Err') actual={error:B.u32_from_term(result.x[0])};
        else {
          assert.equal(result.k,'Ok');const n=result.x[0];assert.equal(n.$,'Ctr');
          if(n.$!=='Ctr') throw new Error('Expected U64');
          actual={value:(BigInt(B.u32_from_term(n.x[0])!)+(BigInt(B.u32_from_term(n.x[1])!)<<32n)).toString()};
        }
        expected=claim.function==='add'?(a+b>max?{error:1}:{value:(a+b).toString()}):(a<b?{error:2}:{value:(a-b).toString()});
      }
      assert.notDeepEqual(actual,expected,'SMT counterexample must replay in checked Bend evaluation');
      claim.replay={bend:actual,mathematical:expected};
    }
  }
  return report;
}
const positive=await run('sdk/math.bend','build/math-refinement',0);
const mutations=[];
const source=fs.readFileSync('sdk/math.bend','utf8');
for(const [name,before,after] of [
  ['wrong carry','U32.is_lt(lo, al)','U32.is_lt(al, lo)'],
  ['lost borrow','Bool.to_u32(U32.is_lt(al, bl))','0'],
  ['reversed comparison','U32.is_lt(ah, bh)','U32.is_lt(bh, ah)'],
]) {
  const dir=fs.mkdtempSync('build/refinement-negative-');
  try {
    assert.ok(source.includes(before));fs.writeFileSync(`${dir}/math.bend`,source.replace(before,after));
    const report=await run(`${dir}/math.bend`,`${dir}/result`,1);mutations.push({name,...report});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
const files=['sdk/math.bend','verification/model.ts','verification/prove.py','verification/check.ts','compiler/primitives.ts'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/math-refinement.json',JSON.stringify({bendCommit:BEND_COMMIT,positive,mutations,hashes},null,2)+'\n');
console.log('Universal checked-u64 add/sub/comparison refinement passed; three faulty implementations yield counterexamples');
