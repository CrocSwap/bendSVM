import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Backend, checkedBook } from '../compiler/backend.ts';
import { writeArtifacts } from '../compiler/artifacts.ts';
import { compileSbf } from '../scripts/build.ts';
import { testPure, type PureCase } from './pure.ts';

export async function testExchange() {
  const emitted=new Backend(await checkedBook('examples/exchange/PROOF.bend')).emit(['exchange.process']);
  writeArtifacts('build/exchange',emitted,'exchange.process');compileSbf('build/exchange.c','build/exchange');
  const source=fs.readFileSync('examples/exchange/exchange.bend','utf8');
  for(const [before,after] of [['Rejected{4}','fill_price(offer, amount, max_payment)'],
    ['Rejected{5}','settle(offer, amount, payment)'],['authorize(signed, fill(offer, amount, max_payment))','fill(offer, amount, max_payment)'],
    ['Bool.and(signed, Sol.equal(actor, maker))','True{}'],['Rejected{7}','Rejected{0}']]) {
    const dir=fs.mkdtempSync('examples/.exchange-negative-');
    try {
      for(const name of ['LAWS.bend','PROOF.bend']) fs.copyFileSync(`examples/exchange/${name}`,`${dir}/${name}`);
      assert.ok(source.includes(before));fs.writeFileSync(`${dir}/exchange.bend`,source.replace(before,after));
      await assert.rejects(()=>checkedBook(`${dir}/PROOF.bend`),/expected|mismatch/i);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  }
  await testPure('examples/exchange/PROOF.bend',['exchange.quote_price'],'build/pricing',schema=>{
    const exp=schema.exports[0],type=schema.types.find(t=>t.name===exp.args[0])!,result=schema.types.find(t=>t.name===exp.result)!;
    if(type.kind!=='adt'||result.kind!=='adt') throw new Error('Expected data');
    const u64=(n:bigint)=>({constructor:type.variants[0].name,fields:{lo:Number(n&0xffffffffn),hi:Number(n>>32n)}});
    const max=(1n<<64n)-1n,cases:PureCase[]=[];
    for(const amount of [0n,1n,2n,3n,7n,1000n,1n<<32n,1n<<63n,max]) for(const [num,den] of [[1n,1n],[2n,3n],[3n,2n],[max,max],[max,1n],[max-1n,max-2n],[1n,max],[1n,0n]]) {
      const cost=den===0n?0n:(amount*num+den-1n)/den;
      const error=den===0n?3:cost>max?1:0;
      cases.push({name:exp.name,args:[u64(amount),u64(num),u64(den)],expected:error?
        {constructor:result.variants.find(v=>v.name.endsWith('.Err'))!.name,fields:{code:error}}:
        {constructor:result.variants.find(v=>v.name.endsWith('.Ok'))!.name,fields:{value:u64(cost)}}});
    }
    return cases;
  });
  console.log('Exchange laws/five negative mutations passed; shared adapter built');
}
