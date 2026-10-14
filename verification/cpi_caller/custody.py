"""Reviewed-template CPI custody model; deterministic PDA syscall remains trusted."""
import hashlib
import z3 as z
from cpi_validate import helper
from cpi_composition import live_function_body,c_tokens
from adapter_contract_c import audited_header_tokens,unique_file_scope_name,has_file_scope_tokens,strict_tokens,Grammar
SIGNATURE='static inline u64 bend_invoke_custody(Account *a, const u8 *program, u8 *bump)'
BODY="""{
 const u8 prefix[4]={'b','e','n','d'};
 BendSeed seeds[2]={{prefix,4},{a[0].key,32}}; u8 key[32];
 if(sol_try_find_program_address(seeds,2,program,key,bump)) return 11;
 return equal_key(key,a[3].key)?0:11;
}"""
def need(ok,why):
 if not ok:raise Grammar(why)
def parse(files):
 runtime={n:files[n] for n in ('bend_cpi.h','cpi_abi.h','solana_min.h')}
 helper(runtime)
 headers={n:audited_header_tokens(n,t) for n,t in runtime.items()}
 for name in ('bend_invoke_custody','sol_try_find_program_address'):
  unique_file_scope_name(list(headers.values()),name)
 for name,decl in [('bend_cpi.h',SIGNATURE+' {'),('cpi_abi.h','extern u64 sol_try_find_program_address(const BendSeed *, int, const u8 *, u8 *, u8 *);'),('cpi_abi.h','typedef struct { const u8 *address; u64 length; } BendSeed;')]:
  need(has_file_scope_tokens(headers[name],strict_tokens(decl)),'CPI custody declaration: '+name)
 need(live_function_body(runtime['bend_cpi.h'],SIGNATURE,'CPI custody')==c_tokens(BODY,'CPI custody template'),'CPI custody body differs from reviewed template')
 return {'seedAccount':0,'custodyAccount':3,'prefix':'bend','headerSha256':hashlib.sha256(runtime['bend_cpi.h'].encode()).hexdigest()}
def outputs(parsed,keys,program):
 need(len(keys)==12 and all(z.is_bv(k) and k.size()==256 for k in keys),'CPI custody account key widths')
 need(z.is_bv(program) and program.size()==256,'CPI custody program width')
 key_sort=z.BitVecSort(256);args=(keys[parsed['seedAccount']],program)
 rc=z.Function('cpi_custody_pda_result',key_sort,key_sort,z.BitVecSort(64))(*args)
 key=z.Function('cpi_custody_pda_key',key_sort,key_sort,key_sort)(*args)
 bump=z.Function('cpi_custody_pda_bump',key_sort,key_sort,z.BitVecSort(8))(*args)
 status=z.If(rc!=0,z.BitVecVal(11,64),z.If(key==keys[parsed['custodyAccount']],z.BitVecVal(0,64),z.BitVecVal(11,64)))
 return status,bump,z.And(rc==0,key==keys[3])
