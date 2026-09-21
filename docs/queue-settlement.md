# Paged funded settlement queue (implementation contract)

A queue stores fixed-width recipient/amount obligations in a separate program-owned
collection account. Small state binds owner, mint, exact vault and collection key,
tracks appended count, settlement cursor and remaining escrow obligation.

Initialize creates an empty collecting queue. Each authorized append adds one
positive obligation and transfers its amount from the actor's token account to
the exact vault in the same transaction. Checked arithmetic rejects overflow.
Seal fixes a nonempty queue for settlement; no later append is allowed.
Settle processes one or two obligations starting exactly at the stored cursor.
A bounded fold constructs ordered transfers to the recorded recipients, subtracts
each amount with checked arithmetic, and advances the cursor only on success.
The final page must leave zero remaining obligation and closes the queue.
Closed queues reject further operations. Donations do not increase obligations.

Accounts 0–4 are state, actor, Token Program, custody PDA, collection. Append adds
actor source 5, exact vault 6 and mint 7. Settlement adds exact vault 5, mint 6,
and one or two recipient token accounts from index 7. Initialization and sealing
need only the shared prefix. All addresses must be distinct. The source owner
must sign every operation and the runtime collection key must match stored state.

Accepted outcomes preserve collection windows except append, which initializes
one record at the tail. Adapter validation/encoding precedes effects. Failed
funding or a later failed settlement transfer must roll back token changes,
state progress and collection writes together.

Acceptance requires large queues processed across many transactions, page sizes
one/two, exact amounts/recipients/custody binding, unauthorized/phase/replay errors,
zero/overflow cases, malformed collections and rollback after an earlier transfer
has succeeded. Source proofs must bind the implemented traversal, checked
arithmetic and guards, including progress and conservation. An independent Rust
program must pass the same conformance fixtures and matched benchmarks.

The source application and shared ABI-3 adapter now build a 35,192-byte SBF ELF.
Run `npm run test:queue` to build checked laws, exercise four negative law variants,
check the generated client and execute four real-token SBF tests.

Current tests pass 65 funded obligations stored in an 11,064-byte allocation and
settled in pages of one/two records. They check exact recipient balances, remaining
vault funds, cursor advancement and byte-for-byte preservation of obligations.
They also cover authorization, phase/replay guards, zero amounts, empty sealing,
full capacity, bad fuel, exact vault/collection/recipient bindings, tampered final
conservation, donated tokens and full-U64 aggregate overflow. A frozen second
destination causes the entire page to roll back, including the first transfer.
An unfunded append leaves no new record or accounting change.

Six checked Bend laws cover terminal behavior, rejection guards and arithmetic
error propagation. The [source refinement](queue-refinement.md) additionally
passes 428 claims, seven mutation counterexamples with Bend replays, and exact
arithmetic binding checks. The independent Rust implementation passes the same
four conformance tests; the [benchmark](queue-benchmark.md) compares 26 matching,
repeatable operations. Final adapter hardening/resource reporting and the complete
milestone regression audit remain outstanding. Status: implementation in progress.
