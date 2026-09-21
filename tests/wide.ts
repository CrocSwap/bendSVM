import { testPure, type PureCase } from './pure.ts';
import type { WireValue } from '../sdk/wire.ts';

export async function testWide() {
  await testPure('sdk/wide.bend',['floor','ceil'],'build/wide',() => {
    const ctor = (constructor: string,fields: Record<string,WireValue>) => ({constructor,fields});
    const u64 = (n: bigint) => ctor('math.U64',{lo:Number(n&0xffffffffn),hi:Number(n>>32n)});
    const max=(1n<<64n)-1n;
    const triples: bigint[][] = [];
    const boundary=[0n,1n,2n,(1n<<32n)-1n,1n<<32n,(1n<<63n),max-1n,max];
    for (const a of boundary) for (const b of boundary) {
      triples.push([a,b,b],[a,b,a > 0n ? a : 1n],[a,b,max]);
    }
    triples.push([max,max,0n],[max,max,1n],[max,max,max-1n],[max,2n,2n],
      [max-1n,max-1n,max-2n]);
    let seed=0x9175bac;
    const word=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return BigInt(seed>>>0);};
    const random=()=> (word()<<32n)|word();
    for(let i=0;i<32;++i) triples.push([random(),random(),random()]);
    const seen=new Set<string>(),cases:PureCase[]=[];
    for(const [a,b,d] of triples) {
      const key=`${a},${b},${d}`; if(seen.has(key)) continue; seen.add(key);
      for(const name of ['floor','ceil']) {
        const q=d===0n ? 0n : (a*b+(name==='ceil'?d-1n:0n))/d;
        const error=d===0n ? 3 : q>max ? 1 : 0;
        cases.push({name,args:[u64(a),u64(b),u64(d)],expected:error ? ctor('math.Err',{code:error}) : ctor('math.Ok',{value:u64(q)})});
      }
    }
    return cases;
  });
}
