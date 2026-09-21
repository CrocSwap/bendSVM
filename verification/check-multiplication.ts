import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {prepareBend,BEND_COMMIT} from '../scripts/build.ts';

prepareBend();
const {model}=await import('./model.ts');
const {checkedBook}=await import('../compiler/backend.ts');
const B=await import('../.deps/bend/bend2/bend.ts');
fs.mkdirSync('build',{recursive:true});
const mathRoots=['mul32_parts','mul32','mul_parts','mul'];
const wideRoots=['add','product_parts','product'];
async function run(math:string,wide:string,stem:string,status:number) {
  for(const [source,roots,suffix] of [[math,mathRoots,'math'],[wide,wideRoots,'wide']] as const)
    fs.writeFileSync(`${stem}.${suffix}.model.json`,JSON.stringify(await model(source,[...roots]))+'\n');
  const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/multiplication.py',`${stem}.math.model.json`,`${stem}.wide.model.json`],{encoding:'utf8'});
  assert.equal(result.status,status,result.stderr||result.stdout);
  const report=JSON.parse(result.stdout);
  if(status===0) {
    assert.equal(report.claims.length,14);
    assert.ok(report.claims.every((c:any)=>c.result==='unsat'));
  }
  return report;
}
const positive=await run('sdk/math.bend','sdk/wide.bend','build/multiplication-refinement',0);
const math=fs.readFileSync('sdk/math.bend','utf8'),wide=fs.readFileSync('sdk/wide.bend','utf8');
const mask=(1n<<64n)-1n;
const u32=(n:bigint)=>B.term_higher(B.u32_to_term(Number(n)));
const u64=(n:bigint,prefix='')=>B.Ctr(prefix+'U64',[u32(n&0xffffffffn),u32(n>>32n)]);
const u128=(n:bigint)=>B.Ctr('U128',[u64(n&mask,'math.'),u64(n>>64n,'math.')]);
function number(t:any):bigint {
  assert.equal(t.$,'Ctr');
  if(t.k==='U128')return number(t.x[0])+(number(t.x[1])<<64n);
  assert.ok(t.k==='U64'||t.k==='math.U64');
  return BigInt(B.u32_from_term(t.x[0])!)+(BigInt(B.u32_from_term(t.x[1])!)<<32n);
}
const mutations=[];
for(const [label,file,before,after,claimName,root] of [
  ['lost middle carry','math','U32.div(middle, 65536)','0','mul32_parts','mul32_parts'],
  ['ignored high product','math','Bool.or(high, Bool.or','Bool.or(False{}, Bool.or','mul_parts','mul_parts'],
  ['lost wide carry','wide','Bool.to_u32(Math.less(low, al))','0','wide-add','add'],
  ['misplaced cross product','wide','Math.U64{0, l1}','Math.U64{l1, 0}','wide-product-parts','product_parts'],
]) {
  const dir=fs.mkdtempSync('build/multiplication-negative-');
  try {
    const original=file==='math'?math:wide;
    assert.equal(original.split(before).length,2,'Mutation must have one exact target');
    fs.writeFileSync(`${dir}/math.bend`,file==='math'?math.replace(before,after):math);
    fs.writeFileSync(`${dir}/wide.bend`,file==='wide'?wide.replace(before,after):wide);
    const report=await run(`${dir}/math.bend`,`${dir}/wide.bend`,`${dir}/result`,1);
    const claim=report.claims.find((c:any)=>c.claim===claimName);
    assert.equal(claim?.result,'sat','Mutation must produce a counterexample, not unknown');
    const c=Object.fromEntries(Object.entries(claim.counterexample).map(([k,v])=>[k,BigInt(v as string)]));
    let args:any[],expected:any;
    if(root==='mul32_parts') {
      args=[c.p0,c.p1,c.p2,c.p3].map(u32);
      expected=((c.p0+(c.p1<<16n)+(c.p2<<16n)+(c.p3<<32n))&mask).toString();
    } else if(root==='mul_parts') {
      args=[...[c.p0,c.p1,c.p2].map(n=>u64(n)),B.Ctr(c.high===1n?'True':'False',[])];
      const total=c.p0+(c.p1<<32n)+(c.p2<<32n);
      expected=c.high===1n||total>mask?{error:1}:{value:total.toString()};
    } else if(root==='add') {
      args=[u128(c.a),u128(c.b)];expected=((c.a+c.b)&((1n<<128n)-1n)).toString();
    } else {
      args=[c.p0,c.p1,c.p2,c.p3].map(n=>u64(n,'math.'));
      expected=((c.p0+(c.p1<<32n)+(c.p2<<32n)+(c.p3<<64n))&((1n<<128n)-1n)).toString();
    }
    const book=await checkedBook(`${dir}/${file}.bend`);
    const result=B.term_snf(book,args.reduce((f,x)=>B.App(f,x),B.Ref(root)));
    assert.equal(result.$,'Ctr');
    let actual:any;
    if(root==='mul_parts')actual=result.k==='Err'?{error:B.u32_from_term(result.x[0])}:{value:number(result.x[0]).toString()};
    else actual=number(result).toString();
    assert.notDeepEqual(actual,expected,'Helper counterexample must replay in checked Bend');
    claim.replay={bend:actual,mathematical:expected};
    mutations.push({label,...report});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
// Routing obligations quantify abstract products. Their SAT models need not be
// realizable integer multiplications, so use separate concrete source witnesses.
for(const [label,file,before,after,claimName,root,a,b] of [
  ['wrong 16-bit limb','math','U32.mul(ah, bl), U32.mul(al, bh)','U32.mul(ah, bh), U32.mul(al, bh)','mul32-routing','mul32',65537n,2n],
  ['wrong checked cross limb','math','mul32(ah, bl), Bool.and','mul32(ah, bh), Bool.and','mul-routing','mul',(1n<<32n)+1n,2n],
  ['wrong wide high limb','wide','Math.mul32(ah, bh))','Math.mul32(ah, bl))','product-routing','product',(1n<<32n)+1n,2n],
] as const) {
  const dir=fs.mkdtempSync('build/multiplication-routing-negative-');
  try {
    const original=file==='math'?math:wide;
    assert.equal(original.split(before).length,2);
    fs.writeFileSync(`${dir}/math.bend`,file==='math'?math.replace(before,after):math);
    fs.writeFileSync(`${dir}/wide.bend`,file==='wide'?wide.replace(before,after):wide);
    const report=await run(`${dir}/math.bend`,`${dir}/wide.bend`,`${dir}/result`,1);
    assert.equal(report.claims.find((c:any)=>c.claim===claimName)?.result,'sat');
    const book=await checkedBook(`${dir}/${file}.bend`);
    const args=root==='mul32'?[u32(a),u32(b)]:[u64(a,file==='wide'?'math.':''),u64(b,file==='wide'?'math.':'')];
    const result=B.term_snf(book,B.App(B.App(B.Ref(root),args[0]),args[1]));
    assert.equal(result.$,'Ctr');
    const actual=root==='mul'?(result.k==='Err'?{error:B.u32_from_term(result.x[0])}:{value:number(result.x[0]).toString()}):number(result).toString();
    const expected=root==='mul'?{value:(a*b).toString()}:(a*b).toString();
    assert.notDeepEqual(actual,expected);
    mutations.push({label,...report,concreteWitness:{a:a.toString(),b:b.toString(),bend:actual,mathematical:expected}});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
const files=['sdk/math.bend','sdk/wide.bend','verification/model.ts','verification/prove.py','verification/division_loop.py','verification/multiplication.py','verification/check-multiplication.ts','compiler/primitives.ts'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/multiplication-refinement.json',JSON.stringify({bendCommit:BEND_COMMIT,positive,mutations,hashes},null,2)+'\n');
console.log('Multiplication refinement passed: 14 obligations; four helper counterexamples replayed; three routing mutations detected with concrete Bend witnesses');
