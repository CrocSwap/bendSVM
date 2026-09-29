#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include "bend_collection_runtime.h"

static void test_equal_key(void) {
  u8 left[40], right[40];
  for (unsigned i = 0; i < sizeof(left); ++i) left[i] = (u8)(i * 37 + 11);
  for (unsigned left_offset = 0; left_offset < 8; ++left_offset) {
    const u8 *a = left + left_offset;
    assert(equal_key(a, a));
    for (unsigned right_offset = 0; right_offset < 8; ++right_offset) {
      u8 *b = right + right_offset;
      memcpy(b, a, 32);
      assert(equal_key(a, b) && equal_key(b, a));
      for (unsigned byte = 0; byte < 32; ++byte) {
        b[byte] ^= 1;
        assert(!equal_key(a, b) && !equal_key(b, a));
        b[byte] ^= 1;
      }
      assert(equal_key(a, b));
    }
  }
}

int main(void) {
  test_equal_key();
  u8 program[32] = {1}, state[32] = {2}, header[20] = {66,68,67,49,7};
  const u32 capacities[] = {0,1,16,4096}, strides[] = {1,4,37};
  unsigned checks = 0;
  for (unsigned ci=0; ci<4; ++ci) for (unsigned si=0; si<3; ++si) {
    u32 capacity = capacities[ci], stride = strides[si];
    u64 size = BEND_COLLECTION_HEADER + (u64)capacity * stride;
    u8 *data = calloc((size_t)size,1), *before = malloc((size_t)size);
    assert(data && before);
    Account a = {.owner=program,.data=data,.size=size,.writable=1,.signer=1};
    BendCollection c;
    assert(!bend_collection_open(&a,program,state,header,stride,1,&c));
    assert(c.capacity==capacity && c.length==0);
    BendCollectionWindow w;
    assert(bend_collection_select(&c,0,0,4,&w));
    assert(bend_collection_plan(&c,&w,0,0));
    bend_collection_commit(&c,&w,0,0,NULL,header,state);
    assert(!bend_collection_open(&a,program,state,header,stride,0,&c));
    /* Commit real appends, then reload metadata and check every new record. */
    for(u32 start=0;start<capacity;) {
      u32 count=capacity-start<4?capacity-start:4;
      assert(bend_collection_select(&c,start,count,4,&w));
      assert(w.loaded==0 && bend_collection_plan(&c,&w,count,start+count));
      u8 encoded[4*37];memset(encoded,(u8)start,sizeof(encoded));
      bend_collection_commit(&c,&w,count,start+count,encoded,header,state);
      assert(!bend_collection_open(&a,program,state,header,stride,0,&c));
      assert(c.length==start+count);
      for(u64 i=56+(u64)start*stride;i<56+(u64)c.length*stride;++i)assert(data[i]==(u8)start);
      start+=count;
    }
    for (u32 length=0; length<=capacity; length += capacity>16 ? 1024 : 1) {
      write_le(data+20,length,4);
      for(u64 i=56;i<size;++i)data[i]=(u8)(i*17+3);
      assert(!bend_collection_open(&a,program,state,header,stride,0,&c));
      u32 starts[] = {0,length/2,length,capacity,0xffffffffu};
      for(unsigned j=0;j<5;++j) for(u32 count=0;count<=5;++count) {
        u32 start=starts[j];
        unsigned valid=start<=length && count<=4 && (u64)start+count<=capacity;
        memcpy(before,data,(size_t)size);
        assert(bend_collection_select(&c,start,count,4,&w)==valid);
        assert(!memcmp(before,data,(size_t)size));
        if(!valid)continue;
        assert(w.loaded==(length-start<count?length-start:count));
        for(u32 i=0;i<=w.loaded;++i) {
          const u8 *record=bend_collection_record(&c,&w,i);
          assert(i==w.loaded ? record==NULL : record==data+56+(u64)(start+i)*stride);
        }
        for(u32 written=0;written<=5;++written) for(u32 added=0;added<=5;++added) {
          u32 next=length+added;
          unsigned expected=written>=w.loaded && written<=count && next<=capacity &&
            written-w.loaded==added && (!added || (u64)start+w.loaded==length);
          assert(bend_collection_plan(&c,&w,written,next)==expected);
          checks++;
        }
        u8 encoded[4*37];memset(encoded,0xa7,sizeof(encoded));
        assert(bend_collection_plan(&c,&w,w.loaded,length));
        bend_collection_commit(&c,&w,w.loaded,length,encoded,header,state);
        for(u64 i=56;i<size;++i) {
          unsigned changed=i>=56+(u64)start*stride && i<56+(u64)(start+w.loaded)*stride;
          assert(data[i]==(changed?0xa7:before[i]));
        }
        memcpy(data,before,(size_t)size);
      }
    }
    a.writable=0;assert(bend_collection_open(&a,program,state,header,stride,0,&c)==5);a.writable=1;
    a.executable=1;assert(bend_collection_open(&a,program,state,header,stride,0,&c)==3);a.executable=0;
    a.owner=state;assert(bend_collection_open(&a,program,state,header,stride,0,&c)==3);a.owner=program;
    assert(bend_collection_open(&a,program,program,header,stride,0,&c)==4);
    data[4]^=1;assert(bend_collection_open(&a,program,state,header,stride,0,&c)==4);data[4]^=1;
    write_le(data+20,(u64)capacity+1,4);assert(bend_collection_open(&a,program,state,header,stride,0,&c)==4);
    assert(bend_collection_open(&a,program,state,header,0,0,&c)==4);
    a.size=55;assert(bend_collection_open(&a,program,state,header,stride,0,&c)==4);a.size=size;
    if(stride>1){a.size++;assert(bend_collection_open(&a,program,state,header,stride,0,&c)==4);a.size=size;}
    a.size=56+0x100000000ULL*stride;assert(bend_collection_open(&a,program,state,header,stride,0,&c)==4);a.size=size;
    assert(bend_collection_open(&a,program,state,header,stride,1,&c)==4);
    a.signer=0;assert(bend_collection_open(&a,program,state,header,stride,1,&c)==7);
    free(data);free(before);
  }
  assert(checks>10000);
  return 0;
}
