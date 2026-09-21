#pragma once
#include "cpi_abi.h"

/* Effects bind both the expected mint and recipient owner. Source authority is
 * either the transaction actor or the PDA derived from this state address. */
typedef struct { u32 active, source, destination, mint, authority, recipient;
  u8 mint_key[32], recipient_key[32]; u64 amount;
  u32 initialize, source_bound, destination_bound, fresh_destination;
  u8 source_key[32], destination_key[32]; } BendTransfer;

static inline int bend_token_program(const Account *a) {
  const u8 key[32] = {6,221,246,225,215,101,161,147,217,203,225,70,206,235,121,172,28,180,133,237,95,91,55,145,58,140,245,133,126,255,0,169};
  return a->executable && equal_key(a->key, key);
}
static inline u64 bend_custody(Account *accounts, const u8 *program, u8 *bump) {
  if (!bend_token_program(&accounts[2])) return 10;
  const u8 prefix[4] = {'b','e','n','d'};
  BendSeed seeds[2] = {{prefix,4},{accounts[0].key,32}};
  u8 key[32];
  if (sol_try_find_program_address(seeds, 2, program, key, bump)) return 11;
  return equal_key(key, accounts[3].key) ? 0 : 11;
}

/* Validate every leg before invoking any. Token program remains authoritative
 * for frozen accounts, balances, and other token-state restrictions. */
static inline u64 bend_transfer_validate(const BendTransfer *t, Account *a, unsigned count) {
  if (!t->active) return 0;
  if (t->mint < 4 || t->mint >= count) return 12;
  Account *mint = &a[t->mint];
  if (!equal_key(mint->owner,a[2].key) || mint->executable) return 13;
  if (mint->size != 82 || mint->data[45] != 1) return 14;
  if (!equal_key(mint->key,t->mint_key)) return 15;
  if (t->active == 2) return 0;
  if (t->active == 3 || t->active == 4) {
    if (!mint->writable) return 5;
    /* Issuance only for a mint exclusively controlled by this custody PDA. */
    if (read_le(mint->data,4) != 1 || !equal_key(mint->data+4,a[3].key) ||
        read_le(mint->data+46,4) != 0) return 23;
    if (t->active == 3 && t->initialize && read_le(mint->data+36,8) != 0) return 24;
    unsigned index = t->active == 3 ? t->destination : t->source;
    if (index < 4 || index >= count || index == t->mint) return 12;
    Account *token = &a[index];
    if (!token->writable) return 5;
    if (!equal_key(token->owner,a[2].key) || token->executable) return 13;
    if (token->size != 165 || (token->data[108] != 1 && token->data[108] != 2) ||
        read_le(token->data+109,4) != 0) return 14;
    if (!equal_key(token->data,mint->key)) return 15;
    if (t->active == 4) {
      if (!a[1].signer || !equal_key(token->data+32,a[1].key)) return 16;
    } else {
      if (t->recipient > 2 || t->initialize > 1) return 9;
      const u8 *recipient = t->recipient == 2 ? t->recipient_key : a[t->recipient ? 3 : 1].key;
      if (!equal_key(token->data+32,recipient)) return 17;
    }
    return 0;
  }
  if (t->active != 1) return 9;
  if (t->source < 4 || t->destination < 4 ||
      t->source >= count || t->destination >= count ||
      t->source == t->destination || t->source == t->mint || t->destination == t->mint) return 12;
  Account *src = &a[t->source], *dst = &a[t->destination];
  if (!src->writable || !dst->writable) return 5;
  if (!equal_key(src->owner,a[2].key) || !equal_key(dst->owner,a[2].key) ||
      !equal_key(mint->owner,a[2].key) || src->executable || dst->executable || mint->executable) return 13;
  if (src->size != 165 || dst->size != 165 || mint->size != 82 || mint->data[45] != 1 ||
      (src->data[108] != 1 && src->data[108] != 2) || (dst->data[108] != 1 && dst->data[108] != 2) ||
      read_le(src->data+109,4) != 0 || read_le(dst->data+109,4) != 0) return 14;
  if (!equal_key(mint->key,t->mint_key) || !equal_key(src->data,mint->key) || !equal_key(dst->data,mint->key)) return 15;
  if (t->source_bound > 1 || t->destination_bound > 1 || t->fresh_destination > 1) return 9;
  if ((t->source_bound && !equal_key(src->key,t->source_key)) ||
      (t->destination_bound && !equal_key(dst->key,t->destination_key))) return 25;
  if (t->fresh_destination && (read_le(dst->data+64,8) != 0 ||
      read_le(dst->data+72,4) != 0 || read_le(dst->data+129,4) != 0 ||
      !equal_key(dst->data+32,a[3].key))) return 26;
  if (t->authority > 1 || t->recipient > 2) return 9;
  const u8 *authority = a[t->authority ? 3 : 1].key;
  if ((!t->authority && !a[1].signer) || !equal_key(src->data+32,authority)) return 16;
  const u8 *recipient = t->recipient == 2 ? t->recipient_key : a[t->recipient ? 3 : 1].key;
  if (!equal_key(dst->data+32,recipient)) return 17;
  return 0;
}

static __attribute__((noinline)) u64 bend_transfer_execute(const BendTransfer *t, Account *a, unsigned count, u8 bump) {
  if (t->active != 1 && t->active != 3 && t->active != 4) return 0;
  BendAccountInfo infos[12];
  for (unsigned i = 0; i < count; ++i) infos[i] = (BendAccountInfo){
    a[i].key,a[i].lamports,a[i].size,a[i].data,a[i].owner,a[i].rent_epoch,
    a[i].signer != 0,a[i].writable != 0,a[i].executable != 0};
  BendAccountMeta metas[4];
  unsigned meta_count;
  u8 data[10] = {12}; /* SPL Token TransferChecked */
  if (t->active == 1) {
    metas[0]=(BendAccountMeta){a[t->source].key,1,0};
    metas[1]=(BendAccountMeta){a[t->mint].key,0,0};
    metas[2]=(BendAccountMeta){a[t->destination].key,1,0};
    metas[3]=(BendAccountMeta){a[t->authority ? 3 : 1].key,0,1}; meta_count=4;
  } else if (t->active == 3) {
    data[0]=14; /* MintToChecked */
    metas[0]=(BendAccountMeta){a[t->mint].key,1,0};
    metas[1]=(BendAccountMeta){a[t->destination].key,1,0};
    metas[2]=(BendAccountMeta){a[3].key,0,1}; meta_count=3;
  } else {
    data[0]=15; /* BurnChecked */
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
}
