#![no_std]

use core::panic::PanicInfo;

extern "C" {
    fn sol_set_return_data(data: *const u8, length: u64) -> u64;
}

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

fn read_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes.try_into().expect("fixed-width arithmetic input"))
}

fn put_u32(output: &mut [u8], offset: usize, value: u32) {
    output[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn checked(value: Option<u64>, error: u32) -> (u32, u64) {
    match value {
        Some(value) => (0, value),
        None => (error, 0),
    }
}

#[no_mangle]
pub unsafe extern "C" fn entrypoint(input: *mut u8) -> u64 {
    let input = core::slice::from_raw_parts(input, 33);
    if read_u64(&input[..8]) != 0 || read_u64(&input[8..16]) != 17 {
        return 1;
    }

    let wire = &input[16..];
    let opcode = wire[0];
    let a = u64::from(u32::from_le_bytes(wire[1..5].try_into().unwrap()))
        | (u64::from(u32::from_le_bytes(wire[5..9].try_into().unwrap())) << 32);
    let b = u64::from(u32::from_le_bytes(wire[9..13].try_into().unwrap()))
        | (u64::from(u32::from_le_bytes(wire[13..17].try_into().unwrap())) << 32);

    let (error, value) = match opcode {
        0 => checked(a.checked_add(b), 1),
        1 => (0, u64::from(a < b)),
        2 => checked(a.checked_mul(b), 1),
        3 => match b {
            0 => (3, 0),
            _ => (0, a / b),
        },
        4 => match b {
            0 => (3, 0),
            _ => (0, a % b),
        },
        5 => checked(a.checked_sub(b), 2),
        _ => (9, 0),
    };

    let mut output = [0; 12];
    put_u32(&mut output, 0, error);
    put_u32(&mut output, 4, value as u32);
    put_u32(&mut output, 8, (value >> 32) as u32);
    sol_set_return_data(output.as_ptr(), output.len() as u64);
    0
}
