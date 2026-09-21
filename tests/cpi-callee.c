#include "solana_min.h"
/* Independent external-program fixture: requires a forwarded signer, adds to
 * its owned counter, and optionally fails after writing to test rollback. */
__attribute__((visibility("default"))) u64 entrypoint(const u8 *input) {
  if(read_le(input,8)!=2) return 1;
  Account a[2]; const u8 *p=input+8;
  for(unsigned i=0;i<2;++i) {p=read_account(p,&a[i]);if(!p)return 2;}
  u64 length=read_le(p,8);const u8 *data=p+8,*program=data+length;
  if(length!=5 || data[0]>6) return 3;
  unsigned wide=data[0]==3 || data[0]==4 || data[0]==6;
  if(!a[0].writable || a[0].size!=(wide?8:4) || !equal_key(a[0].owner,program))return 4;
  if(!a[1].signer) return 5;
  if(wide && read_le(a[0].data+4,4)!=0xbeefu) return 6;
  write_le(a[0].data,(u32)read_le(a[0].data,4)+(u32)read_le(data+1,4),4);
  if(data[0]==2) { write_le(a[0].data+4,0xbeef,4); write_le(a[0].data-8,8,8); }
  if(data[0]==4) { write_le(a[0].data+4,0,4); write_le(a[0].data-8,4,8); }
  return data[0]==1 || data[0]==6 ? 77 : 0;
}
