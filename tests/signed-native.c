#include <stdint.h>
#include <stdio.h>
#include "signed.h"
static uint64_t signed32(uint32_t value) {
  int64_t exact=value<UINT32_C(2147483648)?(int64_t)value:(int64_t)value-INT64_C(4294967296);
  return (uint64_t)exact;
}
static int64_t signed8(uint32_t value) {
  unsigned byte=value&255u;
  return byte<128u?(int64_t)byte:(int64_t)byte-256;
}
static uint64_t unpack(bend_math_2e_U64_t value) {
  if(value.tag!=0){fputs("bad tag\n",stderr);return UINT64_MAX;}
  return (uint64_t)value.as.c0.f0|((uint64_t)value.as.c0.f1<<32);
}
#define CHECK(condition,reason) do { if(!(condition)){fputs(reason "\n",stderr);return 42;} } while(0)
int main(void) {
  const uint32_t edge[]={0,1,127,128,255,UINT32_C(2147483647),UINT32_C(2147483648),UINT32_MAX};
  unsigned extensions=0,decodes=0,products=0,additions=0;
  for(unsigned i=0;i<8;i++){
    CHECK(unpack(bend_extend32(edge[i]))==signed32(edge[i]),"extension");++extensions;
  }
  for(unsigned i=0;i<8;i++){
    for(unsigned j=0;j<8;j++)for(unsigned high=0;high<4;high++){
      bend_math_2e_U64_t a=bend_math_2e_U64_make(edge[i],high?UINT32_MAX:0);
      bend_math_2e_U64_t b=bend_math_2e_U64_make(edge[j],high&1?UINT32_C(2147483648):1);
      uint32_t sum=(uint32_t)((uint64_t)edge[i]+edge[j]);
      CHECK(unpack(bend_add32_5f_wrap(a,b))==signed32(sum),"addition");++additions;
    }
  }
  for(unsigned high=0;high<4;high++)for(unsigned a=0;a<256;a++){
    uint32_t av=a|(high&1?UINT32_C(0xffffff00):0);
    CHECK(bend_byte_5f_bits(av)==(uint32_t)signed8(av),"decode");++decodes;
    for(unsigned b=0;b<256;b++){
      uint32_t bv=b|(high&2?UINT32_C(0xa55a5a00):0);
      CHECK(unpack(bend_mul8(av,bv))==(uint64_t)(signed8(av)*signed8(bv)),"product");++products;
    }
  }
  uint32_t seed=UINT32_C(0x9e3779b9);
  for(unsigned i=0;i<4096;i++){
    seed=seed*UINT32_C(1664525)+UINT32_C(1013904223);uint32_t a=seed;
    seed=seed*UINT32_C(1664525)+UINT32_C(1013904223);uint32_t b=seed;
    CHECK(unpack(bend_extend32(a))==signed32(a),"extension");++extensions;
    CHECK(unpack(bend_add32_5f_wrap(bend_math_2e_U64_make(a,b),bend_math_2e_U64_make(b,a)))==signed32((uint32_t)((uint64_t)a+b)),"addition");++additions;
  }
  printf("{\"extensions\":%u,\"decodes\":%u,\"products\":%u,\"additions\":%u}\n",extensions,decodes,products,additions);
  return 0;
}
