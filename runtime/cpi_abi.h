#pragma once
#include "solana_min.h"

/* C syscall ABI from the pinned Solana SBF SDK. No host SDK runtime is linked. */
typedef struct { const u8 *key; u64 *lamports; u64 data_len; u8 *data;
  const u8 *owner; u64 rent_epoch; _Bool signer, writable, executable; } BendAccountInfo;
typedef struct { const u8 *key; _Bool writable, signer; } BendAccountMeta;
typedef struct { const u8 *program; BendAccountMeta *accounts; u64 count;
  u8 *data; u64 length; } BendInstruction;
typedef struct { const u8 *address; u64 length; } BendSeed;
typedef struct { const BendSeed *seeds; u64 count; } BendSeeds;
_Static_assert(sizeof(BendAccountInfo) == 56 && sizeof(BendAccountMeta) == 16 &&
  sizeof(BendInstruction) == 40 && sizeof(BendSeed) == 16, "CPI ABI");
extern u64 sol_try_find_program_address(const BendSeed *, int, const u8 *, u8 *, u8 *);
extern u64 sol_invoke_signed_c(const BendInstruction *, const BendAccountInfo *, int, const BendSeeds *, int);
