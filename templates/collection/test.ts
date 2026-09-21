import {createClient} from './dist/program.client.ts';
import type {TestProgram} from '@SDK@/testing.ts';

export default async function test(t:TestProgram) {
  const client=createClient(t.program);
  const accounts={state:await t.key('state'),actor:await t.key('owner'),collection:await t.key('records')};
  const sizes=client.allocationBytes(4096);
  await t.createAccounts([
    {address:accounts.state,bytes:sizes.state},
    {address:accounts.collection,bytes:sizes.collection},
  ],client.instructions.Initialize({},accounts,{mode:'initialize'}));
  t.equal(client.state(await t.data(accounts.state)),{kind:'Ready',owner:accounts.actor,collection:accounts.collection});
  for(const value of [17,42,99])await t.send(client.instructions.Append({value},accounts));
  const before=await t.data(accounts.collection);
  t.equal(before.length,16440);
  t.equal(client.collection(before,accounts.state,0,2),{length:3,capacity:4096,entries:[17,42]});
  t.equal(client.collection(before,accounts.state,2,1).entries,[99]);

  await t.send(client.instructions.Replace({index:1,value:123},accounts));
  const after=await t.data(accounts.collection);
  t.equal(client.collection(after,accounts.state,0,2).entries,[17,123]);
  t.equal(client.collection(after,accounts.state,2,1).entries,[99]);

  // Rejection assertions also check that application accounts stay unchanged.
  const attacker={...accounts,actor:await t.key('attacker')};
  await t.reject(client.instructions.Append({value:7},attacker),{application:1});
  await t.reject(client.instructions.Replace({index:3,value:7},accounts),'invalid-selection');
  await t.reject(client.instructions.Initialize({},accounts),{application:2});
  t.equal(await t.data(accounts.collection),after);
}
