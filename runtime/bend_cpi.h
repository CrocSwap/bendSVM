#pragma once
#include "cpi_abi.h"

typedef struct { u32 index, writable, signer; u8 key[32]; } BendInvokeMeta;
typedef struct { u32 active, program, length, count; u8 program_key[32], data[64]; BendInvokeMeta metas[8]; } BendInvoke;

static inline u64 bend_invoke_custody(Account *a, const u8 *program, u8 *bump) {
  const u8 prefix[4]={'b','e','n','d'};
  BendSeed seeds[2]={{prefix,4},{a[0].key,32}}; u8 key[32];
  if(sol_try_find_program_address(seeds,2,program,key,bump)) return 11;
  return equal_key(key,a[3].key)?0:11;
}
static inline u64 bend_invoke_validate(const BendInvoke *t, Account *a, unsigned count) {
  if(!t->active) return 0;
  if(t->program<2 || t->program>=count || !a[t->program].executable || !equal_key(a[t->program].key,t->program_key)) return 19;
  if(t->length>64 || t->count>8) return 20;
  for(unsigned i=t->length;i<64;++i) if(t->data[i]) return 20;
  for(unsigned i=0;i<t->count;++i) {
    const BendInvokeMeta *m=&t->metas[i];
    if(m->index>=count || m->writable>1 || m->signer>1 || !equal_key(a[m->index].key,m->key)) return 21;
    if(m->writable && !a[m->index].writable) return 21;
    if(m->signer && !a[m->index].signer && m->index!=3) return 21;
    for(unsigned j=0;j<i;++j) if(t->metas[j].index==m->index) return 21;
  }
  return 0;
}
static __attribute__((noinline)) u64 bend_invoke_execute(const BendInvoke *t, Account *a, unsigned count, u8 bump) {
  if(!t->active) return 0;
  BendAccountInfo infos[12];
  for(unsigned i=0;i<count;++i) infos[i]=(BendAccountInfo){a[i].key,a[i].lamports,a[i].size,a[i].data,a[i].owner,a[i].rent_epoch,a[i].signer!=0,a[i].writable!=0,a[i].executable!=0};
  BendAccountMeta metas[8]; unsigned custody=0;
  for(unsigned i=0;i<t->count;++i) {
    const BendInvokeMeta *m=&t->metas[i];metas[i]=(BendAccountMeta){a[m->index].key,m->writable!=0,m->signer!=0};
    if(m->index==3 && m->signer) custody=1;
  }
  BendInstruction ix={a[t->program].key,metas,t->count,(u8 *)t->data,t->length};
  const u8 prefix[4]={'b','e','n','d'}; BendSeed seeds[3]={{prefix,4},{a[0].key,32},{&bump,1}}; BendSeeds signer={seeds,3};
  u64 error=sol_invoke_signed_c(&ix,infos,(int)count,&signer,(int)custody);
  if(error) return error;
  /* CPI can resize external accounts. Keep later calls' account-info lengths
   * synchronized with the syscall's updated C account-info records. */
  for(unsigned i=0;i<count;++i) a[i].size=infos[i].data_len;
  return 0;
}
