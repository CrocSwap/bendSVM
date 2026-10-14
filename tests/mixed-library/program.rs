#![no_std]
#![no_main]

#[cfg(not(target_feature = "static-syscalls"))]
include!("../../build/mixed-library/library.bindings.rs");
#[cfg(target_feature = "static-syscalls")]
include!(env!("BEND_LIBRARY_BINDINGS"));

use core::panic::PanicInfo;

const SENTINEL: u64 = 0x1122_3344_5566_7788;
const REPORT_PREFIX_BYTES: usize = 23;

#[cfg(not(target_feature = "static-syscalls"))]
extern "C" {
    fn sol_set_return_data(data: *const u8, length: u64);
}

#[cfg(target_feature = "static-syscalls")]
unsafe fn sol_set_return_data(data: *const u8, length: u64) {
    // Solana's static syscall ABI: Murmur3-32("sol_set_return_data", seed 0).
    let syscall: extern "C" fn(*const u8, u64) = core::mem::transmute(0xa226_d3ebusize);
    syscall(data, length);
}

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

unsafe fn read_u64(pointer: *const u8) -> u64 {
    let mut value = 0u64;
    for index in 0..8 {
        value |= (*pointer.add(index) as u64) << (index * 8);
    }
    value
}

fn write_u32(bytes: &mut [u8], offset: usize, value: u32) {
    for index in 0..4 {
        bytes[offset + index] = (value >> (index * 8)) as u8;
    }
}

fn write_u64(bytes: &mut [u8], offset: usize, value: u64) {
    for index in 0..8 {
        bytes[offset + index] = (value >> (index * 8)) as u8;
    }
}

#[no_mangle]
pub unsafe extern "C" fn entrypoint(input: *mut u8) -> u64 {
    if read_u64(input) != 0 {
        return 1;
    }
    let instruction_length = read_u64(input.add(8));
    if instruction_length == 0 || instruction_length > 64 {
        return 2;
    }
    let instruction = input.add(16);
    let mode = *instruction;
    let payload = instruction.add(1);
    let payload_length = instruction_length - 1;

    let mut rust_before = instruction_length as u32;
    for index in 0..instruction_length as usize {
        rust_before = rust_before.wrapping_add(*instruction.add(index) as u32);
    }
    let mut bend_output = [0xa5u8; BEND_LIBRARY_OUTPUT_BYTES];
    let mut output_length = SENTINEL;
    let mut alias_buffer = [0xa5u8; 64];
    let mut misaligned_length = [0u8; 9];
    for index in 0..8 {
        misaligned_length[index + 1] = (SENTINEL >> (index * 8)) as u8;
    }
    let status = match mode {
        0 => bend_library_call(
            payload,
            payload_length,
            bend_output.as_mut_ptr(),
            BEND_LIBRARY_OUTPUT_BYTES as u64,
            &mut output_length,
        ),
        1 => bend_library_call(
            payload,
            payload_length,
            bend_output.as_mut_ptr(),
            (BEND_LIBRARY_OUTPUT_BYTES - 1) as u64,
            &mut output_length,
        ),
        2 | 8 | 9 | 10 => bend_library_call(
            payload,
            payload_length,
            bend_output.as_mut_ptr(),
            BEND_LIBRARY_OUTPUT_BYTES as u64,
            &mut output_length,
        ),
        3 => bend_library_call(
            payload,
            payload_length,
            bend_output.as_mut_ptr(),
            (BEND_LIBRARY_OUTPUT_BYTES - 1) as u64,
            &mut output_length,
        ),
        4 => {
            for index in 0..payload_length as usize {
                alias_buffer[index] = *payload.add(index);
            }
            bend_library_call(
                alias_buffer.as_ptr(),
                payload_length,
                alias_buffer.as_mut_ptr(),
                BEND_LIBRARY_OUTPUT_BYTES as u64,
                &mut output_length,
            )
        }
        5 => bend_library_call(
            payload,
            payload_length,
            core::ptr::null_mut(),
            BEND_LIBRARY_OUTPUT_BYTES as u64,
            &mut output_length,
        ),
        6 => bend_library_call(
            core::ptr::null(),
            payload_length,
            bend_output.as_mut_ptr(),
            BEND_LIBRARY_OUTPUT_BYTES as u64,
            &mut output_length,
        ),
        7 => bend_library_call(
            payload,
            payload_length,
            bend_output.as_mut_ptr(),
            BEND_LIBRARY_OUTPUT_BYTES as u64,
            misaligned_length.as_mut_ptr().add(1).cast::<u64>(),
        ),
        _ => return 3,
    };

    if mode == 7 {
        output_length = read_u64(misaligned_length.as_ptr().add(1));
    }
    let unchanged = if mode == 4 {
        let mut same = output_length == SENTINEL;
        for index in 0..payload_length as usize {
            same &= alias_buffer[index] == *payload.add(index);
        }
        same
    } else {
        let mut same = output_length == SENTINEL;
        for byte in bend_output {
            same &= byte == 0xa5;
        }
        same
    };

    let mut rust_after = rust_before ^ status ^ output_length as u32;
    for byte in bend_output {
        rust_after = rust_after.wrapping_mul(33).wrapping_add(byte as u32);
    }
    let mut report = [0u8; REPORT_PREFIX_BYTES + BEND_LIBRARY_OUTPUT_BYTES];
    report[0] = 1;
    report[1] = mode;
    write_u32(&mut report, 2, status);
    write_u64(&mut report, 6, output_length);
    report[14] = u8::from(unchanged);
    write_u32(&mut report, 15, rust_before);
    write_u32(&mut report, 19, rust_after);
    report[REPORT_PREFIX_BYTES..].copy_from_slice(&bend_output);
    sol_set_return_data(report.as_ptr(), report.len() as u64);
    0
}
