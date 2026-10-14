#![no_std]

use core::panic::PanicInfo;

extern "C" {
    fn sol_set_return_data(data: *const u8, length: u64);
}

#[panic_handler]
fn panic(_: &PanicInfo) -> ! { loop {} }

fn word(p: &[u8]) -> u32 { u32::from_le_bytes(p.try_into().unwrap()) }

fn cell(p: &[u8], at: &mut usize) -> Option<i64> {
    if p.get(*at).copied()? != 0 { return None; }
    *at += 1;
    let lo = word(p.get(*at..*at + 4)?);
    let hi = word(p.get(*at + 4..*at + 8)?);
    *at += 8;
    Some(((u64::from(hi) << 32) | u64::from(lo)) as i64)
}

fn pair(p: &[u8], at: &mut usize, level: u32, out: &mut [i64; 64], next: &mut usize) -> Option<()> {
    if p.get(*at).copied()? != 0 { return None; }
    *at += 1;
    for _ in 0..2 {
        if level == 1 {
            out[*next] = cell(p, at)?;
            *next += 1;
        } else {
            pair(p, at, level - 1, out, next)?;
        }
    }
    Some(())
}

fn isqrt(value: u128) -> u64 {
    if value < 2 { return value as u64; }
    let mut x = 1u128 << ((128 - value.leading_zeros() + 1) / 2);
    loop {
        let y = (x + value / x) >> 1;
        if y >= x { return x as u64; }
        x = y;
    }
}

fn compute(samples: &[i64; 64], n: usize, gain: u32) -> (u32, i64) {
    if n == 0 || gain > 65_535 || samples[..n].iter().any(|v| v.unsigned_abs() >= 1 << 26) {
        return (1, 0);
    }
    let sum = samples[..n].iter().map(|v| (v * v) as u64).sum::<u64>();
    let mean = sum / n as u64;
    let root = isqrt(((mean + 17) as u128) << 20) as i64;
    let mut checksum = 0i64;
    for &v in &samples[..n] {
        let numerator = v << 22;
        let q = (2 * numerator + root).div_euclid(2 * root);
        let output = (q * i64::from(gain) + 2048) >> 12;
        checksum = checksum.wrapping_add(output);
    }
    (0, checksum)
}

#[no_mangle]
pub unsafe extern "C" fn entrypoint(input: *mut u8) -> u64 {
    let header = core::slice::from_raw_parts(input, 16);
    if u64::from_le_bytes(header[..8].try_into().unwrap()) != 0 ||
        u64::from_le_bytes(header[8..16].try_into().unwrap()) != 649 { return 1; }
    let p = core::slice::from_raw_parts(input, 16 + 649);
    let wire = &p[16..];
    if wire[0] != 0 { return 2; }
    let n = word(&wire[1..5]) as usize;
    if n > 64 || wire[5] != 0 { return 2; }
    let mut samples = [0i64; 64];
    let mut at = 6;
    let mut next = 0;
    if pair(wire, &mut at, 6, &mut samples, &mut next).is_none() || at != 645 || next != 64 {
        return 2;
    }
    let gain = word(&wire[645..649]);
    let (error, checksum) = compute(&samples, n, gain);
    let mut reply = [0u8; 14];
    reply[1..5].copy_from_slice(&error.to_le_bytes());
    reply[6..14].copy_from_slice(&checksum.to_le_bytes());
    sol_set_return_data(reply.as_ptr(), reply.len() as u64);
    0
}
