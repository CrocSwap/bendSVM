#![no_std]

use core::panic::PanicInfo;

extern "C" { fn sol_set_return_data(data: *const u8, length: u64); }

#[panic_handler]
fn panic(_: &PanicInfo) -> ! { loop {} }

fn word(p: &[u8]) -> u32 { u32::from_le_bytes(p.try_into().unwrap()) }

fn pair(p: &[u8], at: &mut usize, level: u32, out: &mut [u32; 32], next: &mut usize) -> Option<()> {
    if p.get(*at).copied()? != 0 { return None; }
    *at += 1;
    for _ in 0..2 {
        if level == 1 {
            out[*next] = word(p.get(*at..*at + 4)?);
            *at += 4;
            *next += 1;
        } else {
            pair(p, at, level - 1, out, next)?;
        }
    }
    Some(())
}

fn row(p: &[u8], at: &mut usize, out: &mut [u32; 32]) -> Option<()> {
    if p.get(*at).copied()? != 0 { return None; }
    *at += 1;
    let mut next = 0;
    pair(p, at, 5, out, &mut next)?;
    if next != 32 { return None; }
    Some(())
}

fn compute(q: &[u32;32], w: &[u32;32], n: usize, a: u32, m: u32) -> (u32, i64) {
    if n == 0 || n > 32 || a > 1_048_576 || m > 65_535 ||
        q[..n].iter().chain(&w[..n]).any(|&v| v > 255) { return (1,0); }
    let mut dot = 0i64;
    for i in 0..n {
        dot += i64::from(q[i] as u8 as i8) * i64::from(w[i] as u8 as i8);
    }
    // basanos linear_row: rshift_round(rshift_round(dot*m, P1)*a, P-P1).
    let t = (dot * i64::from(m) + 32_768) >> 16;
    (0, (t * i64::from(a) + 32_768) >> 16)
}

#[no_mangle]
pub unsafe extern "C" fn entrypoint(input: *mut u8) -> u64 {
    let header = core::slice::from_raw_parts(input, 16);
    if u64::from_le_bytes(header[..8].try_into().unwrap()) != 0 ||
        u64::from_le_bytes(header[8..16].try_into().unwrap()) != 333 { return 1; }
    let p = core::slice::from_raw_parts(input, 16 + 333);
    let wire = &p[16..];
    if wire[0] != 0 { return 2; }
    let n = word(&wire[1..5]) as usize;
    let mut q = [0u32;32];
    let mut w = [0u32;32];
    let mut at = 5;
    if row(wire, &mut at, &mut q).is_none() || row(wire, &mut at, &mut w).is_none() ||
        at != 325 { return 2; }
    let a = word(&wire[325..329]);
    let m = word(&wire[329..333]);
    let (error, output) = compute(&q, &w, n, a, m);
    let mut reply = [0u8;14];
    reply[1..5].copy_from_slice(&error.to_le_bytes());
    reply[6..14].copy_from_slice(&output.to_le_bytes());
    sol_set_return_data(reply.as_ptr(), reply.len() as u64);
    0
}
