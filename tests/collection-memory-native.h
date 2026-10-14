#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "bend_collection_runtime.h"
static void need(int ok,const char *why){if(!ok){fprintf(stderr,"%s\n",why);exit(42);}}
static void le(u8 *p,u64 x,unsigned n){for(unsigned i=0;i<n;i++){p[i]=(u8)x;x>>=8;}}
static unsigned cases;
static void one(u32 capacity,u32 length,u32 start,u32 reserved,u32 written,unsigned pattern){
 u32 loaded=length-start<reserved?length-start:reserved,added=written-loaded,next=length+added;
 u64 sizes[3]={25,pattern?7:0,56+(u64)capacity*4};size_t bytes=(size_t)(sizes[0]+sizes[1]+sizes[2]+32000);
 u8 *wire=malloc(bytes),*expected=malloc(bytes);need(wire&&expected,"allocation failed");memset(wire,(int)(0x50+pattern),bytes);le(wire,3,8);size_t at=8,locations[3];
 for(unsigned k=0;k<3;k++){
  locations[k]=at;wire[at]=255;wire[at+1]=1;wire[at+2]=1;wire[at+3]=0;
  for(unsigned j=0;j<32;j++){wire[at+8+j]=(u8)(13*k+3*j+pattern);wire[at+40+j]=(u8)(31+j);}
  le(wire+at+72,123+k,8);le(wire+at+80,sizes[k],8);
  at=(at+88+(size_t)sizes[k]+10240+7)&~(size_t)7;le(wire+at,17+k,8);at+=8;
 }
 le(wire+at,10,8);memset(wire+at+8,0x31,42);need(at+50<bytes,"buffer extent");
 Account accounts[3];memset(accounts,0,sizeof(accounts));const u8 *cursor=wire+8;
 for(unsigned i=0;i<3;i++){cursor=read_account(cursor,&accounts[i]);need(cursor!=NULL,"decode failed");need(accounts[i].data==wire+locations[i]+88,"decoder offset");}
 need(cursor==wire+at,"decoder cursor");Account old_accounts[3];memcpy(old_accounts,accounts,sizeof(accounts));
 u8 header[20],encoded[8];for(unsigned i=0;i<20;i++)header[i]=(u8)(i+0x91);for(unsigned i=0;i<8;i++)encoded[i]=(u8)(i*29+pattern);u8 old_header[20],old_encoded[8];memcpy(old_header,header,20);memcpy(old_encoded,encoded,8);
 BendCollection c={&accounts[2],length,capacity,4};BendCollectionWindow w={start,reserved,loaded},old_w=w;
 need(bend_collection_plan(&c,&w,written,next),"independent valid case rejected by plan");
 memcpy(expected,wire,bytes);size_t data=locations[2]+88;
 for(u32 record=0;record<written;record++)for(unsigned octet=0;octet<4;octet++)expected[data+56+4*(start+record)+octet]=encoded[4*record+octet];
 memcpy(expected+data,header,20);le(expected+data+20,next,4);memcpy(expected+data+24,expected+locations[0]+8,32);
 bend_collection_commit(&c,&w,written,next,encoded,header,accounts[0].key);
 need(!memcmp(wire,expected,bytes),"whole serialized buffer mismatch");
 need(!memcmp(accounts,old_accounts,sizeof(accounts)),"account descriptors changed");need(!memcmp(&w,&old_w,sizeof(w)),"window changed");need(c.account==&accounts[2]&&c.capacity==capacity&&c.stride==4&&c.length==next,"collection descriptor mismatch");need(!memcmp(header,old_header,20)&&!memcmp(encoded,old_encoded,8),"source scratch changed");
 free(wire);free(expected);cases++;
}
static void window(u32 cap,u32 length,u32 start){
 for(u32 reserved=0;reserved<=2;reserved++){
  if(reserved>cap-start)continue;u32 loaded=length-start<reserved?length-start:reserved;
  for(u32 written=loaded;written<=reserved;written++){
   u32 added=written-loaded;if(added&&length-start!=loaded)continue;if(added>cap-length)continue;
   for(unsigned pattern=0;pattern<3;pattern++)one(cap,length,start,reserved,written,pattern);
  }
 }
}
int main(void){
 for(u32 cap=0;cap<=5;cap++)for(u32 length=0;length<=cap;length++)for(u32 start=0;start<=length;start++)window(cap,length,start);
 u32 caps[]={31,1024,(10*1024*1024-56)/4};
 for(unsigned i=0;i<3;i++){
  u32 cap=caps[i],lengths[]={0,cap-1,cap};
  for(unsigned j=0;j<3;j++){u32 length=lengths[j];window(cap,length,0);if(length)window(cap,length,length);if(length>1)window(cap,length,length-1);}
 }
 printf("%u whole-buffer commit cases passed\n",cases);return 0;
}
