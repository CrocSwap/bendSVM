import fs from 'node:fs';
import path from 'node:path';

type Edit={file:string;before:string;after:string;description:string};

const edits:Edit[]=[
  {
    file:'program.bend',
    description:'reject zero-valued appends with application code 4',
    before:`    case Append{value}:
      finish(state, C.push(U32, B.Pair<U32>, 2, storage => index => value => B.pair_set(U32, storage, index, value), window, value), U32.add(length, 1))`,
    after:`    case Append{+value}:
      append_result(U32.is_zero(value), state, length, window, value)`,
  },
  {
    file:'program.bend',
    description:'match the bound zero flag and preserve the existing nonzero push transition',
    before:`def apply(state: State, instruction: Instruction, length: U32, window: C.Window<U32, B.Pair<U32>>) -> Outcome:`,
    after:`def append_result(zero: Bool, state: State, length: U32, window: C.Window<U32, B.Pair<U32>>, value: U32) -> Outcome:
  match zero:
    case True{}:
      Rejected{4}
    case False{}:
      finish(state, C.push(U32, B.Pair<U32>, 2, storage => index => value => B.pair_set(U32, storage, index, value), window, value), U32.add(length, 1))

def apply(state: State, instruction: Instruction, length: U32, window: C.Window<U32, B.Pair<U32>>) -> Outcome:`,
  },
  {
    file:'LAWS.bend',
    description:'declare that applying a zero-valued append always returns code 4',
    before:`law invalid_update_preserves_rejection:
  for state: Program.State
  for length: U32
  {Program.finish(state, B.Invalid{}, length) == Program.Rejected{3} : Program.Outcome}`,
    after:`law invalid_update_preserves_rejection:
  for state: Program.State
  for length: U32
  {Program.finish(state, B.Invalid{}, length) == Program.Rejected{3} : Program.Outcome}

# This covers apply after authorization and selection; earlier account checks may reject with other codes.
law zero_append_is_rejected:
  for state: Program.State
  for length: U32
  for window: C.Window<U32, B.Pair<U32>>
  {Program.apply(state, Program.Append{0}, length, window) == Program.Rejected{4} : Program.Outcome}`,
  },
  {
    file:'PROOF.bend',
    description:'add a proof for the zero-append law',
    before:`def Laws.invalid_update_preserves_rejection(state, length):
  {==}`,
    after:`def Laws.invalid_update_preserves_rejection(state, length):
  {==}

def Laws.zero_append_is_rejected(state, length, window):
  {==}`,
  },
  {
    file:'test.ts',
    description:'test zero-append rollback while preserving zero-valued Replace behavior',
    before:`  t.equal(client.collection(before,accounts.state,2,1).entries,[99]);

  await t.send(client.instructions.Replace({index:1,value:123},accounts));`,
    after:`  t.equal(client.collection(before,accounts.state,2,1).entries,[99]);

  await t.reject(client.instructions.Append({value:0},accounts),{application:4});
  t.equal(await t.data(accounts.collection),before);

  await t.send(client.instructions.Replace({index:1,value:123},accounts));`,
  },
  {
    file:'test.ts',
    description:'assert Replace still accepts zero, then restore the existing fixture value',
    before:`  t.equal(client.collection(after,accounts.state,0,2).entries,[17,123]);
  t.equal(client.collection(after,accounts.state,2,1).entries,[99]);

  // Rejection assertions also check that application accounts stay unchanged.`,
    after:`  t.equal(client.collection(after,accounts.state,0,2).entries,[17,123]);
  t.equal(client.collection(after,accounts.state,2,1).entries,[99]);

  await t.send(client.instructions.Replace({index:1,value:0},accounts));
  t.equal(client.collection(await t.data(accounts.collection),accounts.state,0,2).entries,[17,0]);
  await t.send(client.instructions.Replace({index:1,value:123},accounts));
  t.equal(await t.data(accounts.collection),after);

  // Rejection assertions also check that application accounts stay unchanged.`,
  },
];

export function applyFreshDeveloperTutorial(projectDirectory:string) {
  const project=path.resolve(projectDirectory);
  const changed:string[]=[];
  const pending=new Map<string,string>();
  for(const edit of edits){
    const file=path.join(project,edit.file);
    const source=pending.get(file)??fs.readFileSync(file,'utf8');
    const count=source.split(edit.before).length-1;
    if(count!==1)throw new Error(`${edit.file}: expected one exact match for ${edit.description}, found ${count}`);
    pending.set(file,source.replace(edit.before,edit.after));
    if(!changed.includes(edit.file))changed.push(edit.file);
  }
  for(const [file,source] of pending)fs.writeFileSync(file,source);
  return changed;
}

if(import.meta.main){
  const project=process.argv[2];
  if(!project||process.argv.length!==3)throw new Error('Usage: bun scripts/fresh-developer-tutorial.ts <project-directory>');
  for(const file of applyFreshDeveloperTutorial(project))console.log(`Updated ${path.join(project,file)}`);
}
