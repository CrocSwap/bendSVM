#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#define CHECK(x) do{if(!(x)){fprintf(stderr,"check line %d\n",__LINE__);exit(42);}}while(0)
static const void *watched[10]; static size_t lengths[10]; static unsigned watches;
static unsigned char saved[10][4096];
static void watch_add(const void *p,size_t n){CHECK(watches<10&&n<=4096);watched[watches]=p;lengths[watches]=n;memcpy(saved[watches++],p,n);}
static void watch_check(void){for(unsigned i=0;i<watches;i++)if(memcmp(watched[i],saved[i],lengths[i])){fputs("pending bytes changed\n",stderr);exit(43);}}
static void watch_range(const void *p,size_t n){uintptr_t a=(uintptr_t)p;CHECK(n<=UINTPTR_MAX-a);for(unsigned i=0;i<watches;i++){uintptr_t b=(uintptr_t)watched[i];CHECK(lengths[i]<=UINTPTR_MAX-b);if(n&&a<b+lengths[i]&&b<a+n){fputs("pending range exposed\n",stderr);exit(43);}}}
#include "ADAPTER"
static _Alignas(8) u8 input[160000],keys[12][32],program[32]={99},*bytes[12],initial[4][57];
static unsigned calls,failed,returns;static u64 amounts[2];static u32 prior;
static unsigned managed(unsigned j){return j?j+3:0;}
u64 sol_try_find_program_address(const BendSeed *s,int count,const u8 *p,u8 *key,u8 *bump){CHECK(count==2&&s[0].length==4&&!memcmp(s[0].address,"bend",4)&&s[1].length==32&&!memcmp(s[1].address,keys[0],32)&&!memcmp(p,program,32));memcpy(key,keys[3],32);*bump=254;return 0;}
u64 sol_get_clock_sysvar(void *p){memset(p,0,sizeof(BendClock));return 0;}
void sol_set_return_data(const u8 *p,u64 n){CHECK(calls==2&&!failed&&n==1+5*N&&p[0]==0);for(unsigned j=0;j<N;j++){CHECK(p[1+5*j]==0&&read_le(p+2+5*j,4)==(u32)(prior+1));CHECK(!memcmp(bytes[managed(j)]+(j?52:20),p+1+5*j,5));}returns++;}
u64 sol_invoke_signed_c(const BendInstruction *ix,const BendAccountInfo *a,int count,const BendSeeds *seeds,int ns){
 CHECK(calls<2&&count==N+6&&ix->count==4&&ix->length==10&&ix->data[0]==12&&ix->data[9]==9);
 CHECK(read_le(ix->data+1,8)==amounts[calls]&&!memcmp(ix->program,keys[2],32)&&ns==(int)calls);
 unsigned source=calls?N+4:N+3,dest=calls?N+3:N+4;
 unsigned roles[4]={source,N+5,dest,calls?3:1};
 for(unsigned i=0;i<4;i++)CHECK(!memcmp(ix->accounts[i].key,keys[roles[i]],32)&&ix->accounts[i].writable==(i==0||i==2)&&ix->accounts[i].signer==(i==3));
 watch_check();for(unsigned i=0;i<N;i++)CHECK(!memcmp(bytes[managed(i)],initial[i],i?57:25));
 for(int i=0;i<count;i++){CHECK(a[i].data==bytes[i]);watch_range(a[i].data,a[i].data_len);watch_range(a[i].lamports,8);watch_range(a[i].key,32);watch_range(a[i].owner,32);}
 watch_range(ix,sizeof(*ix));watch_range(a,count*sizeof(*a));watch_range(ix->accounts,ix->count*sizeof(*ix->accounts));watch_range(ix->data,ix->length);watch_range(ix->program,32);
 for(unsigned i=0;i<ix->count;i++)watch_range(ix->accounts[i].key,32);
 if(ns){CHECK(seeds->count==3&&seeds->seeds[2].length==1&&seeds->seeds[2].address[0]==254);watch_range(seeds,ns*sizeof(*seeds));for(int i=0;i<ns;i++){watch_range(seeds[i].seeds,seeds[i].count*sizeof(*seeds[i].seeds));for(unsigned j=0;j<seeds[i].count;j++)watch_range(seeds[i].seeds[j].address,seeds[i].seeds[j].length);}}
 calls++;
 /* Arbitrary balance/delegate writes; this is a CPI frame test, not SPL emulation. */
 for(unsigned i=N+3;i<=N+4;i++)for(unsigned j=64;j<108;j++)bytes[i][j]=(u8)(calls*79+i*31+j*17);
 watch_check();return calls==failed?0x100000000ULL:0;
}
static void run(unsigned init,unsigned wide,unsigned fail){
 memset(input,0,sizeof(input));calls=returns=watches=0;failed=fail;prior=init?0:0xffffffffu;
 for(unsigned i=0;i<N+6;i++)for(unsigned j=0;j<32;j++)keys[i][j]=(u8)(11+19*i+3*j);
 const u8 token[32]={6,221,246,225,215,101,161,147,217,203,225,70,206,235,121,172,28,180,133,237,95,91,55,145,58,140,245,133,126,255,0,169};memcpy(keys[2],token,32);
 write_le(input,N+6,8);u8 *p=input+8;
 for(unsigned i=0;i<N+6;i++){unsigned ismanaged=i==0||(i>=4&&i<N+3);u64 size=ismanaged?(i?57:25):(i>=N+3?(i==N+5?82:165):0);p[0]=255;p[1]=ismanaged||i==1;p[2]=ismanaged||i>=N+3;p[3]=i==2;memcpy(p+8,keys[i],32);memcpy(p+40,ismanaged?program:keys[2],32);write_le(p+72,10000,8);write_le(p+80,size,8);bytes[i]=p+88;p=(u8*)(((uintptr_t)(bytes[i]+size+10240)+7)&~(uintptr_t)7);p+=8;}
 HEADER_SETUP
 for(unsigned j=0;j<N;j++){unsigned i=managed(j);if(!init){memcpy(bytes[i],headers[j],20);if(j)memcpy(bytes[i]+20,keys[0],32);bytes[i][j?52:20]=0;write_le(bytes[i]+(j?53:21),prior,4);}memcpy(initial[j],bytes[i],j?57:25);}
 for(unsigned i=N+3;i<=N+4;i++){memcpy(bytes[i],keys[N+5],32);memcpy(bytes[i]+32,keys[i==N+3?1:3],32);bytes[i][108]=1;}bytes[N+5][44]=9;bytes[N+5][45]=1;
 amounts[0]=wide?0x800000000000000bULL:11;amounts[1]=wide?0x100000007ULL:7;
 #define KEY(n) bend__2e__2e__2f_sdk_2f_context_2e_Key_make((u32)read_le(keys[n],4),(u32)read_le(keys[n]+4,4),(u32)read_le(keys[n]+8,4),(u32)read_le(keys[n]+12,4),(u32)read_le(keys[n]+16,4),(u32)read_le(keys[n]+20,4),(u32)read_le(keys[n]+24,4),(u32)read_le(keys[n]+28,4))
 #define AMOUNT(n) bend__2e__2e__2f_sdk_2f_math_2e_U64_make((u32)amounts[n],(u32)(amounts[n]>>32))
 bend_Instruction_t instruction=bend_RoundTrip_make(KEY(N+5),AMOUNT(0),AMOUNT(1));write_le(p,53,8);p[8]=init?0:1;CHECK(bend_Instruction_encode(p+9,52,&instruction));memcpy(p+61,program,32);
 u64 result=entrypoint(input);CHECK(result==(failed?18:0)&&calls==(failed?failed:2)&&returns==!failed);
 for(unsigned j=0;j<N;j++){unsigned i=managed(j);if(failed)CHECK(!memcmp(bytes[i],initial[j],j?57:25));else{CHECK(!memcmp(bytes[i],headers[j],20)&&read_le(bytes[i]+(j?53:21),4)==(u32)(prior+1));if(j)CHECK(!memcmp(bytes[i]+20,keys[0],32));}}
 printf("case %u %u %u passed\n",init,wide,fail);
}
int main(void){for(unsigned init=0;init<2;init++)for(unsigned wide=0;wide<2;wide++)for(unsigned fail=0;fail<3;fail++)run(init,wide,fail);puts("12 native pending sequences passed");return 0;}
