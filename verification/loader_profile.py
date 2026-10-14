"""Closed header/signature profile for the decoder model."""
from adapter_contract_c import strict_tokens
from collection_caller_syntax import function_body
EXPECTED='''typedef unsigned char u8; typedef unsigned int u32; typedef unsigned long long u64;
_Static_assert(sizeof(u8)==1 && sizeof(u32)==4 && sizeof(u64)==8,"ABI widths");
static inline u64 read_le(const u8 *p,unsigned n){ BODY }
static inline void write_le(u8 *p,u64 v,unsigned n){ BODY }
static inline unsigned equal_key(const u8 *a,const u8 *b){ BODY }
typedef struct {const u8 *key;const u8 *owner;u8 *data;u64 size;u64 *lamports;u64 rent_epoch;unsigned signer,writable,executable;} Account;
static inline const u8 *read_account(const u8 *p,Account *a){ BODY }
extern void sol_set_return_data(const u8 *,u64);'''
def profile(tokens):
 result=[];i=0;names=[]
 while i<len(tokens):
  if tokens[i] in {'read_le','write_le','equal_key','read_account'} and i+1<len(tokens) and tokens[i+1]=='(':
   name=tokens[i];j=i+1;depth=0
   while j<len(tokens):
    if tokens[j]=='(':depth+=1
    if tokens[j]==')':
     depth-=1
     if depth==0:break
    j+=1
   assert j+1<len(tokens) and tokens[j+1]=='{','header signature'
   result+=tokens[i:j+2]+['BODY'];k=j+2;depth=1
   while k<len(tokens):
    if tokens[k]=='{':depth+=1
    if tokens[k]=='}':
     depth-=1
     if depth==0:break
    k+=1
   assert k<len(tokens);result.append('}');names.append(name);i=k+1
  else:result.append(tokens[i]);i+=1
 assert names==['read_le','write_le','equal_key','read_account'],'header function inventory'
 assert result==strict_tokens(EXPECTED),'header declarations/signatures'
def reader(code,number,match):
 b=function_body(code,'read_le',set());join=lambda x:''.join(x)
 assert len(b)==3 and b[0][0]=='simple' and b[1][0]=='for' and b[2]==('return',['v']),'read_le shape'
 initial=number(match(r'u64v=([0-9]+)',join(b[0][1]))[0]);loop=b[1]
 assert join(loop[1])=='unsignedi=0' and join(loop[2])=='i<n' and join(loop[3])=='++i','read_le loop'
 assert loop[4][0]=='simple','read_le loop body'
 shift=number(match(r'v\|=\(u64\)p\[i\]<<\(([0-9]+)\*i\)',join(loop[4][1]))[0])
 assert initial<2**64 and shift*7<64,'read_le width/shift domain'
 return initial,shift
