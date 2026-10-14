"""Conditional CPI frame restricted by audited writable meta keys and token spans.

The token program/runtime must enforce these spans and stable account metadata.
This module proves properties of that contract, not SPL Token implementation.
"""
import re
import z3 as z
from token_executor import Execution,SIGNATURE
from token_frame import data_frame,FRAME_SPEC

def inventory(files):
 evidence=Execution(files).evidence
 body=files['token.h'].split(SIGNATURE,1)[1]
 transfer=body.split('if (t->active == 1) {',1)[1]
 mint=transfer.split('} else if (t->active == 3) {',1)[1]
 burn=mint.split('} else {',1)[1]
 branches={1:transfer.split('} else if',1)[0],3:mint.split('} else {',1)[0],4:burn.split('write_le(',1)[0]}
 roles={}
 for opcode,branch in branches.items():
  matches=re.findall(r'metas\[(\d+)\]\s*=\s*\(BendAccountMeta\)\{a\[([^]]+)\]\.key,([01]),([01])\}',branch)
  assert len(matches)==(4 if opcode==1 else 3)
  assert [int(row[0]) for row in matches]==list(range(len(matches)))
  roles[opcode]=[]
  for pos,expression,writable,signer in matches:
   if writable=='1':
    assert expression in ('t->source','t->mint','t->destination')
    roles[opcode].append(expression[3:])
 return roles,{'executor':evidence,'writableRoles':roles,'byteFrame':FRAME_SPEC}

def writable(slot,index,keys,roles):
 return z.Or(*[z.And(slot[('active',)]==opcode,z.Select(keys,index)==z.Select(keys,slot[(role,)])) for opcode,names in roles.items() for role in names])

def advance(data,sizes,keys,slot,roles,prefix):
 changed=data_frame(data,sizes,prefix)
 index=z.BitVec(prefix+'_frame_index',32)
 return z.Lambda(index,z.If(writable(slot,index,keys,roles),z.Select(changed,index),z.Select(data,index)))
