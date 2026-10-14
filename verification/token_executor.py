"""Restricted token-executor conformance audit; no general C semantics."""
import sys
sys.path.insert(0,'verification')
import token_validate as t
from cpi_composition import live_function_body,c_tokens,SYSCALL_DECL
from adapter_contract_c import audited_header_tokens,unique_file_scope_name,has_file_scope_tokens,strict_tokens,need
SIGNATURE='static __attribute__((noinline)) u64 bend_transfer_execute(const BendTransfer *t, Account *a, unsigned count, u8 bump)'
BODY=r'''{
  if (t->active != 1 && t->active != 3 && t->active != 4) return 0;
  BendAccountInfo infos[12];
  for (unsigned i = 0; i < count; ++i) infos[i] = (BendAccountInfo){
    a[i].key,a[i].lamports,a[i].size,a[i].data,a[i].owner,a[i].rent_epoch,
    a[i].signer != 0,a[i].writable != 0,a[i].executable != 0};
  BendAccountMeta metas[4];
  unsigned meta_count;
  u8 data[10] = {12};
  if (t->active == 1) {
    metas[0]=(BendAccountMeta){a[t->source].key,1,0};
    metas[1]=(BendAccountMeta){a[t->mint].key,0,0};
    metas[2]=(BendAccountMeta){a[t->destination].key,1,0};
    metas[3]=(BendAccountMeta){a[t->authority ? 3 : 1].key,0,1}; meta_count=4;
  } else if (t->active == 3) {
    data[0]=14;
    metas[0]=(BendAccountMeta){a[t->mint].key,1,0};
    metas[1]=(BendAccountMeta){a[t->destination].key,1,0};
    metas[2]=(BendAccountMeta){a[3].key,0,1}; meta_count=3;
  } else {
    data[0]=15;
    metas[0]=(BendAccountMeta){a[t->source].key,1,0};
    metas[1]=(BendAccountMeta){a[t->mint].key,1,0};
    metas[2]=(BendAccountMeta){a[1].key,0,1}; meta_count=3;
  }
  write_le(data+1,t->amount,8); data[9] = a[t->mint].data[44];
  BendInstruction ix = {a[2].key,metas,meta_count,data,10};
  const u8 prefix[4] = {'b','e','n','d'};
  BendSeed seeds[3] = {{prefix,4},{a[0].key,32},{&bump,1}};
  BendSeeds signer = {seeds,3};
  return sol_invoke_signed_c(&ix,infos,(int)count,&signer,t->authority ? 1 : 0);
}'''
WRITE_LE='''static inline void write_le(u8 *p, u64 v, unsigned n) { for (unsigned i = 0; i < n; ++i) p[i] = (u8)(v >> (8 * i)); }'''
DECLS=[
 'typedef struct { const u8 *key; u64 *lamports; u64 data_len; u8 *data; const u8 *owner; u64 rent_epoch; _Bool signer, writable, executable; } BendAccountInfo;',
 'typedef struct { const u8 *key; _Bool writable, signer; } BendAccountMeta;',
 'typedef struct { const u8 *program; BendAccountMeta *accounts; u64 count; u8 *data; u64 length; } BendInstruction;',
 'typedef struct { const u8 *address; u64 length; } BendSeed;',
 'typedef struct { const BendSeed *seeds; u64 count; } BendSeeds;',
]
def audit(files):
 t.helper(files)
 headers={n:audited_header_tokens(n,s) for n,s in files.items()}
 for name in ['bend_transfer_execute','sol_invoke_signed_c','write_le']:unique_file_scope_name(list(headers.values()),name)
 need(has_file_scope_tokens(headers['token.h'],strict_tokens(SIGNATURE+' {')),'executor signature')
 need(has_file_scope_tokens(headers['cpi_abi.h'],strict_tokens(SYSCALL_DECL)),'executor syscall declaration')
 t.file_scope_definition(files,'solana_min.h',WRITE_LE,'write_le')
 for decl in DECLS:t.file_scope_definition(files,'cpi_abi.h',decl,'CPI ABI type')
 actual=live_function_body(files['token.h'],SIGNATURE,'token executor')
 need(actual==c_tokens(BODY,'token executor grammar'),'executor complete body grammar')
 return {'conformance':'complete reviewed token body','infosCapacity':12,'metasCapacity':4,'instructionBytes':10,'syscalls':1,'scope':'Exact full-body token conformance, not semantic preservation. Conditional index/read/loop facts are checked separately against the parsed validator.'}


class Execution:
    """Conditional summary of the exact reviewed C body, not general C semantics.

    Caller must establish validator-derived index/read premises, valid disjoint
    native objects and the runtime syscall frame. Syscall return is an input.
    """
    def __init__(self, files):
        runtime = {name: files[name] for name in ('token.h', 'cpi_abi.h', 'solana_min.h')}
        self.evidence = audit(runtime)
        self.runtime_hashes = {name: t.sha(files[name]) for name in
                               ('token.h', 'cpi_abi.h', 'solana_min.h')}

    def result(self, slot, syscall_result):
        z = t.z3
        active = slot[('active',)]
        t.need_bv(active, 32, 'executor active')
        t.need_bv(syscall_result, 64, 'syscall result')
        invokes = z.Or(active == 1, active == 3, active == 4)
        return z.If(invokes, syscall_result, t.bv(0, 64)), invokes

    def claims(self, model, validation):
        z = t.z3
        f = model.fields
        success = validation == 0
        distinct = z.And(*[z.Implies(z.ULT(t.bv(i), model.count),
                           model.key(t.bv(i)) != model.key(t.bv(0)))
                           for i in range(1, 12)])
        branches = [
            (1, [f['source'], f['mint'], f['destination'],
                 z.If(f['authority'] != 0, t.bv(3), t.bv(1))]),
            (3, [f['mint'], f['destination'], t.bv(3)]),
            (4, [f['source'], f['mint'], t.bv(1)]),
        ]
        claims = {'executor-caller-state-key-distinct': distinct}
        for opcode, metas in branches:
            claims['executor-opcode-' + str(opcode) + '-metas-exclude-state'] = z.Implies(
                z.And(success, f['active'] == opcode, distinct),
                z.And(*[model.key(i) != model.key(t.bv(0)) for i in metas]))
        # Validation alone does NOT establish these two conventions. They
        # must be proved from actual typed extraction at the composed call.
        claims['executor-issuance-authority-convention'] = z.And(
            z.Implies(f['active'] == 3, f['authority'] == 1),
            z.Implies(f['active'] == 4, f['authority'] == 0))
        return claims
