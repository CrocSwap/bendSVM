#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "issuance.c"
static _Alignas(8) u8 buffer[100000];
static u8 keys[7][32],program_id[32]={99},*bytes[7],initial_state[25];
static u64 amounts[3];static unsigned calls,fail_at,returned;static u32 previous;
static unsigned initialize,corrupt_frame;
#define REQUIRE(x) do {if(!(x)){fprintf(stderr,"check failed at line %d\n",__LINE__);exit(42);}}while(0)
u64 sol_try_find_program_address(const BendSeed *seeds,int count,const u8 *program,u8 *key,u8 *bump){
 REQUIRE(count==2&&seeds[0].length==4&&memcmp(seeds[0].address,"bend",4)==0);
 REQUIRE(seeds[1].length==32&&memcmp(seeds[1].address,keys[0],32)==0&&memcmp(program,program_id,32)==0);
 memcpy(key,keys[3],32);*bump=254;return 0;
}
u64 sol_get_clock_sysvar(void *p){memset(p,0,sizeof(BendClock));return 0;}
void sol_set_return_data(const u8 *p,u64 n){
 REQUIRE(calls==3&&fail_at==0&&n==5&&p[0]==0&&read_le(p+1,4)==(u32)(previous+1));
 REQUIRE(memcmp(bytes[0]+20,p,5)==0);++returned;
}
u64 sol_invoke_signed_c(const BendInstruction *ix,const BendAccountInfo *a,int count,const BendSeeds *seeds,int signer_count){
 static const unsigned tags[3]={14,12,15};static const unsigned roles[3][4]={{6,4,3,0},{4,6,5,1},{4,6,1,0}};
 REQUIRE(calls<3&&count==7&&ix->length==10&&ix->data[0]==tags[calls]);
 REQUIRE(read_le(ix->data+1,8)==amounts[calls]&&ix->data[9]==9);
 REQUIRE(memcmp(ix->program,keys[2],32)==0&&ix->count==(calls==1?4:3));
 REQUIRE(signer_count==(calls==0?1:0));
 if(signer_count){REQUIRE(seeds&&seeds->count==3&&seeds->seeds[2].length==1&&seeds->seeds[2].address[0]==254);}
 for(unsigned i=0;i<ix->count;++i){REQUIRE(memcmp(ix->accounts[i].key,keys[roles[calls][i]],32)==0);REQUIRE(memcmp(ix->accounts[i].key,keys[0],32)!=0);}
 REQUIRE(memcmp(bytes[0],initial_state,25)==0); /* No commit before final success. */
 for(unsigned i=0;i<7;++i){REQUIRE(a[i].data==bytes[i]&&memcmp(a[i].key,keys[i],32)==0);}
 ++calls;
 /* Deliberately arbitrary writes within the stated frame, not SPL emulation. */
 for(unsigned i=4;i<7;++i){
  for(unsigned j=0;j<a[i].data_len;++j){
   unsigned allowed=(a[i].data_len==82&&j>=36&&j<44)||(a[i].data_len==165&&((j>=64&&j<108)||(j>=121&&j<129)));
   if(allowed)a[i].data[j]=(u8)(calls*79+i*31+j*17+1);
  }
 }
 if(corrupt_frame&&calls==1)bytes[6][44]^=1;
 return calls==fail_at?0x100000000ULL:0;
}
static void run_case(unsigned init,u32 old,unsigned failed,unsigned wide){
 memset(buffer,0,sizeof buffer);memset(keys,0,sizeof keys);
 for(unsigned i=0;i<7;++i)for(unsigned j=0;j<32;++j)keys[i][j]=(u8)(11+i*19+j*3);
 const u8 token[32]={6,221,246,225,215,101,161,147,217,203,225,70,206,235,121,172,28,180,133,237,95,91,55,145,58,140,245,133,126,255,0,169};memcpy(keys[2],token,32);
 calls=returned=0;fail_at=failed;previous=old;initialize=init;
 u64 sizes[7]={25,0,0,0,165,165,82};write_le(buffer,7,8);u8 *p=buffer+8;
 for(unsigned i=0;i<7;++i){
  p[0]=255;p[1]=(i==0||i==1);p[2]=(i==0||i>=4);p[3]=i==2;
  memcpy(p+8,keys[i],32);memcpy(p+40,i==0?program_id:keys[2],32);write_le(p+72,10000,8);write_le(p+80,sizes[i],8);bytes[i]=p+88;
  p=(u8*)(((unsigned long)(bytes[i]+sizes[i]+10240)+7)&~7UL);p+=8;
 }
 HEADER_SETUP
 if(!init){memcpy(bytes[0],expected_header,20);bytes[0][20]=0;write_le(bytes[0]+21,old,4);}
 memcpy(initial_state,bytes[0],25);
 for(unsigned i=4;i<=5;++i){memcpy(bytes[i],keys[6],32);memcpy(bytes[i]+32,keys[i==4?1:3],32);bytes[i][108]=1;}
 write_le(bytes[6],1,4);memcpy(bytes[6]+4,keys[3],32);bytes[6][44]=9;bytes[6][45]=1;
 amounts[0]=wide?0x800000000000000bULL:11;amounts[1]=wide?0x100000007ULL:7;amounts[2]=3;
 #define KEY(n) bend__2e__2e__2f_sdk_2f_context_2e_Key_make((u32)read_le(keys[n],4),(u32)read_le(keys[n]+4,4),(u32)read_le(keys[n]+8,4),(u32)read_le(keys[n]+12,4),(u32)read_le(keys[n]+16,4),(u32)read_le(keys[n]+20,4),(u32)read_le(keys[n]+24,4),(u32)read_le(keys[n]+28,4))
 #define AMOUNT(n) bend__2e__2e__2f_sdk_2f_math_2e_U64_make((u32)amounts[n],(u32)(amounts[n]>>32))
 bend_Instruction_t instruction=bend_Run_make(KEY(6),AMOUNT(0),AMOUNT(1),AMOUNT(2),init,KEY(5),bend__2e__2e__2f_sdk_2f_issuance_2e_Exact_make(KEY(4)));
 write_le(p,130,8);p[8]=init?0:1;REQUIRE(bend_Instruction_encode(p+9,129,&instruction));memcpy(p+138,program_id,32);
 u64 result=entrypoint(buffer);REQUIRE(result==(failed?18:0));REQUIRE(calls==(failed?failed:3));
 if(failed){REQUIRE(returned==0&&memcmp(bytes[0],initial_state,25)==0);}
 else {REQUIRE(returned==1&&memcmp(bytes[0],expected_header,20)==0&&bytes[0][20]==0&&read_le(bytes[0]+21,4)==(u32)(old+1));}
 printf("{\"initialize\":%u,\"wide\":%u,\"failAt\":%u,\"calls\":%u,\"result\":%llu,\"returns\":%u,\"counter\":%llu}\n",init,wide,failed,calls,result,returned,read_le(bytes[0]+21,4));
}
int main(int argc,char **argv){corrupt_frame=argc>1;for(unsigned init=0;init<2;++init)for(unsigned wide=0;wide<2;++wide)for(unsigned fail=0;fail<4;++fail)run_case(init,init?0:0xffffffffu,fail,wide);puts("16 adapter sequences passed");return 0;}
