// Adapter used by the live harness: application instruction plans come from
// the generated public client, while the Rust runner owns signing and RPC.
import {createClient} from '../../build/queue.client.js';

type Request = {
  program:string;
  instruction:'Initialize'|'Append'|'Seal'|'Settle';
  args:Record<string,unknown>;
  accounts:Record<string,string>;
  mode:'initialize'|'transition';
  remaining:Array<{address:string;signer:boolean;writable:boolean}>;
};

const request=JSON.parse(process.argv[2]??'') as Request;
if(!request||!request.program||!request.instruction||!request.accounts)
  throw new Error('Usage: generated-client.ts <JSON request>');
if(request.instruction==='Append'&&typeof request.args.amount==='string')
  request.args.amount=BigInt(request.args.amount);
const client=createClient(request.program);
const plan=client.instructions[request.instruction](request.args as never,request.accounts as never,{
  mode:request.mode,
  remaining:request.remaining,
});
console.log(JSON.stringify({
  accounts:plan.accounts,
  data:Buffer.from(plan.data).toString('base64'),
}));
