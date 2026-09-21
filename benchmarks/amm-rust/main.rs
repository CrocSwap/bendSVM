//! Standalone Rust SBF baseline. Account validation precedes every token CPI;
//! state is committed only after all effects succeed, matching the shared ABI.
#![no_std]
mod pricing;
mod transition;
mod wire;
use core::{ptr, slice};
use transition::{Authority, Effect, Key, State};

#[derive(Clone, Copy)]
#[repr(C)]
struct Account {
    key: *const u8,
    lamports: *mut u64,
    data_len: u64,
    data: *mut u8,
    owner: *const u8,
    rent_epoch: u64,
    signer: bool,
    writable: bool,
    executable: bool,
}
impl Account {
    fn key(&self) -> &Key {
        unsafe { &*self.key.cast() }
    }
    fn owner(&self) -> &Key {
        unsafe { &*self.owner.cast() }
    }
    fn bytes(&self) -> &[u8] {
        unsafe { slice::from_raw_parts(self.data, self.data_len as usize) }
    }
}
#[derive(Clone, Copy)]
#[repr(C)]
struct Meta {
    key: *const u8,
    writable: bool,
    signer: bool,
}
#[repr(C)]
struct Cpi {
    program: *const u8,
    accounts: *const Meta,
    count: u64,
    data: *const u8,
    length: u64,
}
#[repr(C)]
struct Seed {
    address: *const u8,
    length: u64,
}
#[repr(C)]
struct Signer {
    seeds: *const Seed,
    count: u64,
}
extern "C" {
    fn sol_try_find_program_address(
        seeds: *const Seed,
        count: i32,
        program: *const u8,
        key: *mut u8,
        bump: *mut u8,
    ) -> u64;
    fn sol_invoke_signed_c(
        ix: *const Cpi,
        accounts: *const Account,
        count: i32,
        signers: *const Signer,
        signer_count: i32,
    ) -> u64;
    fn sol_get_clock_sysvar(clock: *mut u8) -> u64;
    fn sol_set_return_data(data: *const u8, length: u64);
    fn abort() -> !;
}
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    unsafe { abort() }
}
const TOKEN: Key = [
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
];
const PREFIX: &[u8; 4] = b"bend";
fn number(data: &[u8], start: usize, length: usize) -> u64 {
    let mut result = 0;
    for i in 0..length {
        result |= u64::from(data[start + i]) << (8 * i);
    }
    result
}
fn authority(value: Authority) -> usize {
    match value {
        Authority::Actor => 1,
        Authority::Custody => 3,
    }
}
fn token_shape(a: &Account) -> bool {
    a.data_len == 165 && matches!(a.bytes()[108], 1 | 2) && number(a.bytes(), 109, 4) == 0
}
fn token_owned(a: &Account, accounts: &[Account]) -> bool {
    !a.executable && a.owner() == accounts[2].key()
}

fn validate(effect: &Effect, accounts: &[Account]) -> Result<(), u64> {
    let (mint_index, mint_key) = match effect {
        Effect::None => return Ok(()),
        Effect::Transfer { mint, mint_key, .. }
        | Effect::Mint { mint, mint_key, .. }
        | Effect::Burn { mint, mint_key, .. } => (*mint, mint_key),
    };
    if mint_index < 4 || mint_index >= accounts.len() {
        return Err(12);
    }
    let mint = &accounts[mint_index];
    if !token_owned(mint, accounts) {
        return Err(13);
    }
    if mint.data_len != 82 || mint.bytes()[45] != 1 {
        return Err(14);
    }
    if mint.key() != mint_key {
        return Err(15);
    }
    match effect {
        Effect::Transfer {
            source,
            destination,
            authority: auth,
            recipient,
            source_key,
            destination_key,
            fresh_destination,
            ..
        } => {
            if *source < 4
                || *destination < 4
                || *source >= accounts.len()
                || *destination >= accounts.len()
                || source == destination
                || *source == mint_index
                || *destination == mint_index
            {
                return Err(12);
            }
            let src = &accounts[*source];
            let dst = &accounts[*destination];
            if !src.writable || !dst.writable {
                return Err(5);
            }
            if !token_owned(src, accounts) || !token_owned(dst, accounts) {
                return Err(13);
            }
            if !token_shape(src) || !token_shape(dst) {
                return Err(14);
            }
            if src.bytes()[..32] != *mint.key() || dst.bytes()[..32] != *mint.key() {
                return Err(15);
            }
            if source_key.is_some_and(|key| key != *src.key())
                || destination_key.is_some_and(|key| key != *dst.key())
            {
                return Err(25);
            }
            if *fresh_destination
                && (number(dst.bytes(), 64, 8) != 0
                    || number(dst.bytes(), 72, 4) != 0
                    || number(dst.bytes(), 129, 4) != 0
                    || dst.bytes()[32..64] != *accounts[3].key())
            {
                return Err(26);
            }
            if (*auth == Authority::Actor && !accounts[1].signer)
                || src.bytes()[32..64] != *accounts[authority(*auth)].key()
            {
                return Err(16);
            }
            if dst.bytes()[32..64] != *accounts[authority(*recipient)].key() {
                return Err(17);
            }
        }
        Effect::Mint { destination, .. }
        | Effect::Burn {
            source: destination,
            ..
        } => {
            if !mint.writable {
                return Err(5);
            }
            if number(mint.bytes(), 0, 4) != 1
                || mint.bytes()[4..36] != *accounts[3].key()
                || number(mint.bytes(), 46, 4) != 0
            {
                return Err(23);
            }
            if matches!(
                effect,
                Effect::Mint {
                    initialize: true,
                    ..
                }
            ) && number(mint.bytes(), 36, 8) != 0
            {
                return Err(24);
            }
            if *destination < 4 || *destination >= accounts.len() || *destination == mint_index {
                return Err(12);
            }
            let token = &accounts[*destination];
            if !token.writable {
                return Err(5);
            }
            if !token_owned(token, accounts) {
                return Err(13);
            }
            if !token_shape(token) {
                return Err(14);
            }
            if token.bytes()[..32] != *mint.key() {
                return Err(15);
            }
            if matches!(effect, Effect::Burn { .. }) {
                if !accounts[1].signer || token.bytes()[32..64] != *accounts[1].key() {
                    return Err(16);
                }
            } else if token.bytes()[32..64] != *accounts[1].key() {
                return Err(17);
            }
        }
        Effect::None => {}
    }
    Ok(())
}

#[inline(never)]
fn execute(effect: &Effect, accounts: &[Account], bump: u8) -> u64 {
    let blank = Meta {
        key: ptr::null(),
        writable: false,
        signer: false,
    };
    let mut metas = [blank; 4];
    let meta = |index: usize, writable, signer| Meta {
        key: accounts[index].key,
        writable,
        signer,
    };
    let (opcode, mint, amount, count, custody) = match *effect {
        Effect::None => return 0,
        Effect::Transfer {
            source,
            destination,
            mint,
            amount,
            authority: auth,
            ..
        } => {
            metas = [
                meta(source, true, false),
                meta(mint, false, false),
                meta(destination, true, false),
                meta(authority(auth), false, true),
            ];
            (12, mint, amount, 4, auth == Authority::Custody)
        }
        Effect::Mint {
            destination,
            mint,
            amount,
            ..
        } => {
            metas[0] = meta(mint, true, false);
            metas[1] = meta(destination, true, false);
            metas[2] = meta(3, false, true);
            (14, mint, amount, 3, true)
        }
        Effect::Burn {
            source,
            mint,
            amount,
            ..
        } => {
            metas[0] = meta(source, true, false);
            metas[1] = meta(mint, true, false);
            metas[2] = meta(1, false, true);
            (15, mint, amount, 3, false)
        }
    };
    let mut data = [0; 10];
    data[0] = opcode;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    data[9] = accounts[mint].bytes()[44];
    let ix = Cpi {
        program: accounts[2].key,
        accounts: metas.as_ptr(),
        count,
        data: data.as_ptr(),
        length: 10,
    };
    let seeds = [
        Seed {
            address: PREFIX.as_ptr(),
            length: 4,
        },
        Seed {
            address: accounts[0].key,
            length: 32,
        },
        Seed {
            address: &bump,
            length: 1,
        },
    ];
    let signer = Signer {
        seeds: seeds.as_ptr(),
        count: 3,
    };
    unsafe {
        sol_invoke_signed_c(
            &ix,
            accounts.as_ptr(),
            accounts.len() as i32,
            &signer,
            i32::from(custody),
        )
    }
}

// Only the loader's serialized-buffer bounds are trusted. Account contents and
// instruction bytes are checked before they are interpreted or changed.
#[no_mangle]
pub unsafe extern "C" fn entrypoint(input: *const u8) -> u64 {
    match run(input) {
        Ok(()) => 0,
        Err(code) => code,
    }
}
unsafe fn run(input: *const u8) -> Result<(), u64> {
    let count = ptr::read_unaligned(input.cast::<u64>()) as usize;
    if !(4..=12).contains(&count) {
        return Err(1);
    }
    let blank = Account {
        key: ptr::null(),
        lamports: ptr::null_mut(),
        data_len: 0,
        data: ptr::null_mut(),
        owner: ptr::null(),
        rent_epoch: 0,
        signer: false,
        writable: false,
        executable: false,
    };
    let mut storage = [blank; 12];
    let mut p = input.add(8);
    for i in 0..count {
        if *p != 255 {
            return Err(6);
        }
        let data_len = ptr::read_unaligned(p.add(80).cast::<u64>());
        let data = p.add(88) as *mut u8;
        let rent = ((data.add(data_len as usize + 10240) as usize + 7) & !7) as *const u8;
        storage[i] = Account {
            key: p.add(8),
            owner: p.add(40),
            lamports: p.add(72) as *mut u64,
            data_len,
            data,
            rent_epoch: ptr::read_unaligned(rent.cast()),
            signer: *p.add(1) != 0,
            writable: *p.add(2) != 0,
            executable: *p.add(3) != 0,
        };
        for j in 0..i {
            if storage[i].key() == storage[j].key() {
                return Err(6);
            }
        }
        p = rent.add(8);
    }
    let accounts = &storage[..count];
    let length = ptr::read_unaligned(p.cast::<u64>()) as usize;
    let ix = p.add(8);
    let program = ix.add(length);
    if length != wire::INSTRUCTION_BYTES || *ix > 1 {
        return Err(2);
    }
    if !accounts[2].executable || *accounts[2].key() != TOKEN {
        return Err(10);
    }
    let seeds = [
        Seed {
            address: PREFIX.as_ptr(),
            length: 4,
        },
        Seed {
            address: accounts[0].key,
            length: 32,
        },
    ];
    let mut derived = [0; 32];
    let mut bump = 0;
    if sol_try_find_program_address(seeds.as_ptr(), 2, program, derived.as_mut_ptr(), &mut bump)
        != 0
        || derived != *accounts[3].key()
    {
        return Err(11);
    }
    let state = &accounts[0];
    if state.owner() != &*program.cast::<Key>() || state.executable {
        return Err(3);
    }
    if !state.writable {
        return Err(5);
    }
    if state.data_len != wire::STATE_BYTES as u64 {
        return Err(4);
    }
    let before = if *ix == 0 {
        if !state.signer {
            return Err(7);
        }
        if state.bytes().iter().any(|byte| *byte != 0) {
            return Err(4);
        }
        State::Empty
    } else {
        wire::state(state.bytes()).ok_or(4u64)?
    };
    let (_, instruction) = wire::instruction(slice::from_raw_parts(ix, length)).ok_or(2u64)?;
    let mut clock = [0u64; 5];
    if sol_get_clock_sysvar(clock.as_mut_ptr().cast()) != 0 {
        return Err(8);
    }
    let (after, effects) = transition::process(accounts[1].signer, before, instruction)
        .map_err(|code| 256 + u64::from(code))?;
    let encoded = wire::payload(after);
    for effect in &effects {
        validate(effect, accounts)?;
    }
    for effect in &effects {
        if execute(effect, accounts, bump) != 0 {
            return Err(18);
        }
    }
    ptr::copy_nonoverlapping(wire::HEADER.as_ptr(), state.data, 20);
    ptr::copy_nonoverlapping(encoded.as_ptr(), state.data.add(20), wire::PAYLOAD_BYTES);
    sol_set_return_data(encoded.as_ptr(), wire::PAYLOAD_BYTES as u64);
    Ok(())
}
