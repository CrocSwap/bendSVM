#include <stdio.h>
#include <string.h>
#include <stdlib.h>
static unsigned run_calls;
#include "collection-store.c"
static unsigned returns,clock_failure;
static u8 returned[5];
u64 sol_get_clock_sysvar(void *p){BendCollectionClock *clock=p;memset(clock,0,sizeof(*clock));clock->slot=123;return clock_failure;}
void sol_set_return_data(const u8 *p,u64 n){if(n!=5){fprintf(stderr,"return size mismatch\n");exit(42);}memcpy(returned,p,5);returns++;}
static void put(u8 *p,u32 n){for(unsigned i=0;i<4;i++)p[i]=(u8)(n>>(8*i));}
static void require(int condition,const char *label){if(!condition){fprintf(stderr,"%s\n",label);exit(42);}}
static unsigned entry_fault;
static void store64(u8 *p,u64 n){for(unsigned i=0;i<8;i++){p[i]=(u8)n;n>>=8;}}
static u64 load64(const u8 *p){u64 out=0;for(unsigned i=0;i<8;i++)out|=(u64)p[i]<<(8*i);return out;}
static u64 entry_fixture(Account *accounts,const u8 *program,const u8 *ix){
 u8 *input=calloc(40000,1),*expected=malloc(40000);require(input&&expected,"allocation failed");
 size_t at=8,records[3],data[3];store64(input,3);
 for(unsigned i=0;i<3;i++){
  records[i]=at;input[at]=255;input[at+1]=accounts[i].signer;input[at+2]=accounts[i].writable;input[at+3]=accounts[i].executable;
  memcpy(input+at+8,accounts[i].key,32);memcpy(input+at+40,accounts[i].owner,32);store64(input+at+72,*accounts[i].lamports);store64(input+at+80,accounts[i].size);
  data[i]=at+88;memcpy(input+data[i],accounts[i].data,accounts[i].size);at=data[i]+accounts[i].size+10240;while(at%8)at++;store64(input+at,accounts[i].rent_epoch);at+=8;
 }
 store64(input+at,10);memcpy(input+at+8,ix,10);memcpy(input+at+18,program,32);
 if(entry_fault>=1&&entry_fault<=3)input[records[entry_fault-1]]=0;
 if(entry_fault>=4&&entry_fault<=6){unsigned to=entry_fault==4?1:2,from=entry_fault==6?1:0;memcpy(input+records[to]+8,input+records[from]+8,32);}
 if(entry_fault==7||entry_fault==8)store64(input,entry_fault==7?2:4);
 if(entry_fault==9||entry_fault==10)store64(input+at,entry_fault==9?9:11);
 if(entry_fault==11)input[at+8]=2;
 memcpy(expected,input,40000);u64 status=entrypoint(input);
 for(unsigned i=0;i<3;i++){
  memcpy(accounts[i].data,input+data[i],accounts[i].size);*accounts[i].lamports=load64(input+records[i]+72);
  if(!status)memcpy(expected+data[i],input+data[i],accounts[i].size);
 }
 require(!memcmp(input,expected,40000),"entry changed bytes outside allowed data ranges");free(expected);free(input);return status;
}
static void entry_refusals(void){
 u8 program[32]={1},keys[3][32]={{2},{3},{4}},state[25]={0},actor[7]={0},collection[68]={0},ix[10]={0};u64 balance[3]={100,200,300};
 Account a[3]={{.key=keys[0],.owner=program,.data=state,.size=25,.lamports=&balance[0],.signer=1,.writable=1},
 {.key=keys[1],.owner=program,.data=actor,.size=7,.lamports=&balance[1],.signer=1},
 {.key=keys[2],.owner=program,.data=collection,.size=68,.lamports=&balance[2],.signer=1,.writable=1}};
 for(entry_fault=1;entry_fault<=11;entry_fault++){
  returns=0;run_calls=0;u64 status=entry_fixture(a,program,ix);require(run_calls==0,"entry refusal reached handler");require(status==(entry_fault<=6?6:entry_fault<=8?1:2),"entry refusal status mismatch");require(returns==0,"entry refusal returned data");
 }
 entry_fault=0;
}

int main(void){
 unsigned checked=11;entry_refusals();
 for(unsigned initialize=0;initialize<2;initialize++)for(unsigned length=0;length<=3;length++)for(unsigned high=0;high<2;high++)for(unsigned scenario=0;scenario<16;scenario++){
  if(initialize&&length)continue;
  u8 program[32],keys[3][32],wrong[32];for(unsigned j=0;j<32;j++){program[j]=(u8)(j*7+1);wrong[j]=(u8)(j*9+7);for(unsigned i=0;i<3;i++)keys[i][j]=(u8)(j*5+i+10);}
  u8 state[25]={0},collection[68]={0},actor[7]={1,2,3,4,5,6,7};u64 balances[3]={100,200,300};
  u32 count=initialize?0:high?0xffffffffu:0;
  if(!initialize){memcpy(state,state_header,20);put(state+21,count);memcpy(collection,collection_header,20);put(collection+20,length);memcpy(collection+24,keys[0],32);for(unsigned i=0;i<3;i++)put(collection+56+4*i,0x11223344u+i);}
  Account accounts[3]={{.key=keys[0],.owner=program,.data=state,.size=25,.lamports=&balances[0],.signer=1,.writable=1},{.key=keys[1],.owner=wrong,.data=actor,.size=7,.lamports=&balances[1],.signer=1},{.key=keys[2],.owner=program,.data=collection,.size=68,.lamports=&balances[2],.signer=1,.writable=1}};
  u8 ix[10]={0};ix[0]=initialize?0:1;u32 value=0xa1b2c3d4u,index=0;unsigned tag=0,mode=0;
  if(scenario==1||scenario==2){tag=1;index=scenario==1?0:2;}
  if(scenario>=3&&scenario<=6){tag=2;mode=scenario-3;}
  ix[1]=(u8)tag;put(ix+2,tag==0?value:tag==1?index:mode);if(tag==1)put(ix+6,value);
  if(scenario==7)ix[1]=255;if(scenario==8)ix[9]=1;
  if(scenario==9)accounts[0].owner=wrong;if(scenario==10)accounts[2].owner=wrong;
  if(scenario==11)accounts[0].writable=0;if(scenario==12)accounts[2].writable=0;
  if(scenario==13)state[20]=1;if(scenario==14)collection[24]^=1;
  clock_failure=scenario==15;returns=0;memset(returned,0xcc,5);
  u8 oldstate[25],oldcollection[68];memcpy(oldstate,state,25);memcpy(oldcollection,collection,68);
  u64 expected=0;
  if(scenario==9||scenario==10)expected=3;else if(scenario==11||scenario==12)expected=5;else if(scenario==13||scenario==14)expected=4;else if(scenario==7||scenario==8)expected=2;else if(scenario==15)expected=8;
  else if(tag==0&&length==3)expected=23;else if(tag==1&&index>=length)expected=23;else if(tag==2&&length==0)expected=23;else if(tag==2&&mode<3)expected=9;
  u64 status=entry_fixture(accounts,program,ix);require(status==expected,"status mismatch");
  if(expected){require(!memcmp(state,oldstate,25)&&!memcmp(collection,oldcollection,68),"refusal changed account bytes");require(returns==0,"refusal returned data");}
  else{
   u8 wantstate[25],wantcollection[68];memcpy(wantstate,oldstate,25);memcpy(wantcollection,oldcollection,68);memcpy(wantstate,state_header,20);wantstate[20]=0;put(wantstate+21,count+1);
   memcpy(wantcollection,collection_header,20);memcpy(wantcollection+24,keys[0],32);put(wantcollection+20,length+(tag==0));
   if(tag==0||tag==1)put(wantcollection+56+4*(tag==0?length:index),value);
   require(!memcmp(state,wantstate,25),"state bytes mismatch");require(!memcmp(collection,wantcollection,68),"collection bytes mismatch");require(returns==1&&!memcmp(returned,wantstate+20,5),"return bytes mismatch");
  }
  require(balances[0]==100&&balances[1]==200&&balances[2]==300,"lamports changed");require(!memcmp(actor,(u8[]){1,2,3,4,5,6,7},7),"actor bytes changed");checked++;
 }
 printf("%u caller cases passed\n",checked);return 0;
}
