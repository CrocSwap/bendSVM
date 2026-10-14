#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Observations inserted after actual extraction, before either helper. */
static const unsigned char *watched[16];
static size_t watched_size[16],watched_count;
static unsigned char watched_copy[16][4096];
static void reject(int code,const char *message) {
  fprintf(stderr,"%s\n",message);exit(code);
}
static void watch_add(const void *pointer,size_t size) {
  if(watched_count==16 || size>4096) reject(40,"watch capacity");
  watched[watched_count]=pointer;watched_size[watched_count]=size;
  memcpy(watched_copy[watched_count],pointer,size);watched_count++;
}
static void watch_check(void) {
  for(size_t i=0;i<watched_count;i++)
    if(memcmp(watched[i],watched_copy[i],watched_size[i]))
      reject(43,"pending bytes changed");
}
static void watch_range(const void *pointer,size_t size) {
  uintptr_t begin=(uintptr_t)pointer;
  if(size>UINTPTR_MAX-begin) reject(44,"pending range exposed");
  for(size_t i=0;i<watched_count;i++) {
    uintptr_t other=(uintptr_t)watched[i];
    if(begin<other+watched_size[i] && other<begin+size)
      reject(44,"pending range exposed");
  }
}
static void watch_poison(void) {
  if(!watched_count) reject(40,"missing observations");
  ((unsigned char*)watched[0])[0]^=1;
}

/* ACTUAL_ADAPTER */

static unsigned calls,returned,fail_call,resize_mode;
static u64 expected_length[12];
static u8 *data[12],*owner[12];
static u8 managed_before[4][128],return_copy[64];
static u64 raw[20000];
static unsigned scenarios;
/* FIELD_CONSTANTS */

static void managed_check(void) {
  for(unsigned i=0;i<FIELD_COUNT;i++)
    if(memcmp(data[field_index[i]],managed_before[i],field_size[i]))
      reject(45,"managed bytes changed before commit");
}
u64 sol_try_find_program_address(const BendSeed *seeds,int count,
                                const u8 *program,u8 *key,u8 *bump) {
  if(count!=2 || seeds[0].length!=4 || seeds[1].length!=32 ||
     memcmp(seeds[0].address,"bend",4) || program[0]!=100 ||
     seeds[1].address[0]!=1) return 1;
  memset(key,0,32);key[0]=4;*bump=0;return 0;
}
u64 sol_get_clock_sysvar(void *pointer) {
  *(BendClock*)pointer=(BendClock){0};return 0;
}
u64 sol_invoke_signed_c(const BendInstruction *instruction,
                       const BendAccountInfo *accounts,int count,
                       const BendSeeds *seeds,int signers) {
  (void)seeds;
  watch_check();managed_check();
  if(count!=12 || signers!=0 || instruction->count!=1 ||
     instruction->length!=1 || instruction->program[0]!=3 ||
     instruction->accounts[0].key[0]!=12 ||
     !instruction->accounts[0].writable || instruction->accounts[0].signer)
    reject(46,"instruction metadata mismatch");
  if(calls>=2 || instruction->data[0]!=(calls?99:42))
    reject(47,"later effect payload mismatch");
  for(unsigned i=0;i<12;i++) {
    watch_range(accounts[i].data,(size_t)accounts[i].data_len);
    watch_range(accounts[i].key,32);watch_range(accounts[i].owner,32);
    watch_range(accounts[i].lamports,8);
    if(accounts[i].data!=data[i] || accounts[i].owner!=owner[i] ||
       accounts[i].key[0]!=i+1 || !accounts[i].signer ||
       !accounts[i].writable || accounts[i].executable!=(i==2))
      reject(48,"account pointer or flags mismatch");
    if(accounts[i].data_len!=expected_length[i])
      reject(49,"later call stale account length");
  }
  calls++;
  /* Framed external writes may occur even before an explicit error. */
  u64 next=resize_mode==0?192:resize_mode==1?32:128;
  memset(data[11],(int)(60+calls),(size_t)next);
  owner[11][0]=(u8)(100+calls);
  *accounts[11].lamports+=calls;
  write_le(data[11]-8,next,8);
  ((BendAccountInfo*)accounts)[11].data_len=next;
  watch_check();managed_check();
  if(calls==fail_call) return 0x8000000000000012ULL;
  expected_length[11]=next;
  return 0;
}
void sol_set_return_data(const u8 *pointer,u64 size) {
  watch_check();
  if(size!=REPLY_SIZE || returned) reject(50,"reply size mismatch");
  memcpy(return_copy,pointer,(size_t)size);returned++;
}
int main(void) {
  /* Canonical distinct-payload instruction from the actual schema codec. */
  const u8 instruction[]={ /* INSTRUCTION_BYTES */ };
  for(unsigned mode=0;mode<2;mode++)
    for(unsigned prior_case=0;prior_case<2;prior_case++)
      for(resize_mode=0;resize_mode<3;resize_mode++)
        for(fail_call=0;fail_call<3;fail_call++) {
          memset(raw,0,sizeof(raw));memset(return_copy,0,sizeof(return_copy));
          watched_count=calls=returned=0;
          u8 *buffer=(u8*)raw;write_le(buffer,12,8);u64 offset=8;
          u32 prior=mode && prior_case?0xffffffffu:0;
          /* INITIALIZE_ACCOUNTS */
          write_le(buffer+offset,sizeof(instruction)+1,8);
          buffer[offset+8]=(u8)mode;
          memcpy(buffer+offset+9,instruction,sizeof(instruction));
          buffer[offset+9+sizeof(instruction)]=100;
          for(unsigned i=0;i<FIELD_COUNT;i++)
            memcpy(managed_before[i],data[field_index[i]],field_size[i]);
          u64 result=entrypoint(buffer);
          if(fail_call) {
            if(result!=18 || calls!=fail_call || returned)
              reject(51,"failure execution order mismatch");
            managed_check();
          } else {
            if(result || calls!=2 || returned!=1)
              reject(52,"successful execution order mismatch");
            if(return_copy[0]) reject(53,"reply state tag mismatch");
            for(unsigned i=0;i<FIELD_COUNT;i++) {
              u8 expected[128]={0};memcpy(expected,field_header[i],20);
              unsigned payload=20+field_binding[i];
              if(field_binding[i]) expected[20]=1;
              u32 value=prior+i+1;
              write_le(expected+payload+1,value,4);
              if(memcmp(data[field_index[i]],expected,field_size[i]))
                reject(54,"committed state mismatch");
              if(return_copy[1+5*i] ||
                 read_le(return_copy+2+5*i,4)!=value)
                reject(55,"reply state mismatch");
            }
          }
          scenarios++;
        }
  printf("{\"scenarios\":%u,\"pendingBuffers\":%zu}\n",scenarios,watched_count);
  return 0;
}
