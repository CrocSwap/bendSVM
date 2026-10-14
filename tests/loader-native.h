#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "solana_min.h"
static void require(int ok,const char *why){if(!ok){fprintf(stderr,"%s\n",why);exit(42);}}
static void put64(u8 *p,u64 v){for(unsigned j=0;j<8;j++){p[j]=(u8)(v%256);v/=256;}}
static size_t pack(u8 *p,size_t n,unsigned flags,u64 balance,u64 rent){
 p[0]=255;p[1]=(flags&1)?2:0;p[2]=(flags&2)?255:0;p[3]=(flags&4)?1:0;
 for(unsigned i=0;i<32;i++){p[8+i]=(u8)(i*7+3);p[40+i]=(u8)(i*11+9);}
 put64(p+72,balance);put64(p+80,n);
 for(size_t i=0;i<n;i++)p[88+i]=(u8)(i*13+5);
 size_t after=88+n+10240;while(after%8)after++;
 put64(p+after,rent);return after+8;
}
int main(void){
 unsigned cases=0;size_t lengths[41];for(size_t i=0;i<33;i++)lengths[i]=i;
 size_t extras[]={1023,1024,1025,10239,10240,10241,65535,10*1024*1024};memcpy(lengths+33,extras,sizeof(extras));
 u64 values[]={0,0x1122334455667788ULL,~0ULL};
 for(unsigned i=0;i<41;i++)for(unsigned flags=0;flags<8;flags++)for(unsigned v=0;v<3;v++){
  size_t n=lengths[i],allocated=n+22000;u8 *p=calloc(allocated,1),*before=malloc(allocated);require(p&&before,"allocation");
  size_t first=pack(p,n,flags,values[v],values[2-v]),second=pack(p+first,3,7,1,2);memcpy(before,p,allocated);
  Account a,b;memset(&a,0xa5,sizeof(a));memset(&b,0x5a,sizeof(b));const u8 *next=read_account(p,&a);
  require(next==p+first,"cursor mismatch");require(a.key==p+8&&a.owner==p+40&&a.data==p+88&&(u8 *)a.lamports==p+72,"field pointer mismatch");
  require(a.size==n&&*a.lamports==values[v]&&a.rent_epoch==values[2-v],"scalar mismatch");
  require(a.signer==!!(flags&1)&&a.writable==!!(flags&2)&&a.executable==!!(flags&4),"flag mismatch");
  require(read_account(next,&b)==p+first+second&&b.data==p+first+88&&b.size==3&&b.rent_epoch==2,"successor mismatch");
  require(!memcmp(p,before,allocated),"decoder wrote input");free(before);free(p);cases++;
 }
 for(unsigned marker=0;marker<255;marker++){
  u8 p[10400]={0};p[0]=(u8)marker;Account a,b;memset(&a,0xa5,sizeof(a));memcpy(&b,&a,sizeof(a));
  require(read_account(p,&a)==NULL,"duplicate accepted");require(!memcmp(&a,&b,sizeof(a)),"duplicate changed descriptor");cases++;
 }
 printf("%u decoder cases passed\n",cases);return 0;
}
