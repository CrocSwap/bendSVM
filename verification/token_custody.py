"""Reviewed-template custody helper model; PDA derivation is a trusted syscall."""
from pathlib import Path
import re,hashlib,sys
sys.path.insert(0,"verification")
import token_validate as token
from cpi_composition import live_function_body,c_tokens
from adapter_contract_c import audited_header_tokens,unique_file_scope_name,has_file_scope_tokens,strict_tokens,Grammar
import z3 as z
TOKEN=bytes([6,221,246,225,215,101,161,147,217,203,225,70,206,235,121,172,28,180,133,237,95,91,55,145,58,140,245,133,126,255,0,169])
def parse(files):
 runtime={name:files[name] for name in ('token.h','cpi_abi.h','solana_min.h')}
 token.helper(runtime)
 headers={name:audited_header_tokens(name,text) for name,text in runtime.items()}
 for name in ('bend_token_program','bend_custody','sol_try_find_program_address'):
  unique_file_scope_name(list(headers.values()),name)
 token_signature='static inline int bend_token_program(const Account *a)'
 custody_signature='static inline u64 bend_custody(Account *accounts, const u8 *program, u8 *bump)'
 syscall='extern u64 sol_try_find_program_address(const BendSeed *, int, const u8 *, u8 *, u8 *);'
 for name,signature in [('token.h',token_signature+' {'),('token.h',custody_signature+' {'),('cpi_abi.h',syscall)]:
  assert has_file_scope_tokens(headers[name],strict_tokens(signature)), 'custody live declaration'
 text=runtime['token.h']
 compact=''.join(live_function_body(text,token_signature,'token program'))
 pattern=r'\{constu8key\[32\]=\{([0-9,]+)\};returna->executable&&equal_key\(a->key,key\);\}'
 match=re.fullmatch(pattern,compact);assert match,'token program helper template'
 key=bytes(int(x) for x in match[1].split(','));assert len(key)==32
 expected="""static inline u64 bend_custody(Account *accounts, const u8 *program, u8 *bump) {
 if (!bend_token_program(&accounts[2])) return 10;
 const u8 prefix[4] = {'b','e','n','d'};
 BendSeed seeds[2] = {{prefix,4},{accounts[0].key,32}};
 u8 key[32];
 if (sol_try_find_program_address(seeds, 2, program, key, bump)) return 11;
 return equal_key(key, accounts[3].key) ? 0 : 11;
 }"""
 assert live_function_body(text,custody_signature,'custody')==c_tokens(expected[expected.index('{'):],'custody template'),'custody helper template'
 return {'tokenKey':int.from_bytes(key,'little'),'tokenHeaderSha256':hashlib.sha256(text.encode()).hexdigest(),'seedAccount':0,'custodyAccount':3,'tokenAccount':2}
def result(parsed,key2,executable2,key3,syscall_result,derived_key):
 return z.If(z.Not(z.And(executable2,key2==z.BitVecVal(parsed['tokenKey'],256))),z.BitVecVal(10,64),z.If(syscall_result!=0,z.BitVecVal(11,64),z.If(derived_key==key3,z.BitVecVal(0,64),z.BitVecVal(11,64))))
def outputs(parsed,w):
 # The audited helper supplies seeds ("bend", root key) and this program id.
 # UF outputs model the trusted deterministic PDA syscall on those inputs.
 key_sort=z.BitVecSort(256)
 arguments=(w.KEY[0],w.PROGRAM)
 rc=z.Function('custody_pda_result',key_sort,key_sort,z.BitVecSort(64))(*arguments)
 derived=z.Function('custody_pda_key',key_sort,key_sort,key_sort)(*arguments)
 bump=z.Function('custody_pda_bump',key_sort,key_sort,z.BitVecSort(8))(*arguments)
 actual=result(parsed,w.KEY[2],w.EXECUTABLE[2],w.KEY[3],rc,derived)
 expected=z.And(w.KEY[2]==z.BitVecVal(int.from_bytes(TOKEN,'little'),256),w.EXECUTABLE[2],rc==0,derived==w.KEY[3])
 return actual,bump,expected
def bind(parsed,w):
 actual,bump,expected=outputs(parsed,w)
 return [w.SETUP==actual,z.Implies(w.SETUP==0,w.BUMP==bump)],z.And(expected,w.BUMP==bump)
