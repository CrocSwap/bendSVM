#include "solana_min.h"
/* Test-only frame probe: accounts are [record, observed]. It copies what the
 * runtime exposes for the observed account into its own writable record:
 *   [0] receipt counter, [1] writable, [2] signer, [3] executable,
 *   [4..12) size, [12..44) owner, [44..) data.
 * Mode 1 requires the observed account's signature. Mode 2 writes its receipt
 * first and then deliberately writes the observed account's first data byte. */
__attribute__((visibility("default"))) u64 entrypoint(const u8 *input) {
  if(read_le(input,8)!=2) return 1;
  Account a[2]; const u8 *p=input+8;
  for(unsigned i=0;i<2;++i) {p=read_account(p,&a[i]);if(!p)return 2;}
  u64 length=read_le(p,8);const u8 *data=p+8,*program=data+length;
  if(length!=1 || data[0]>2) return 3;
  if(!a[0].writable || !equal_key(a[0].owner,program) || a[0].size!=44+a[1].size) return 4;
  if(data[0]==1 && !a[1].signer) return 5;
  u8 *r=a[0].data;
  r[0]=(u8)(r[0]+1);r[1]=(u8)a[1].writable;r[2]=(u8)a[1].signer;r[3]=(u8)a[1].executable;
  write_le(r+4,a[1].size,8);
  for(unsigned i=0;i<32;++i) r[12+i]=a[1].owner[i];
  for(u64 i=0;i<a[1].size;++i) r[44+i]=a[1].data[i];
  if(data[0]==2) { if(!a[1].size) return 6; a[1].data[0]^=0xff; }
  return 0;
}
