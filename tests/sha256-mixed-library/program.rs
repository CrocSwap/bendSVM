#![no_std]
#![no_main]
include!("library.bindings.rs");
use core::panic::PanicInfo;
extern "C" { fn sol_set_return_data(data: *const u8, length: u64); }
#[panic_handler]
fn panic(_: &PanicInfo) -> ! { loop {} }
unsafe fn read_u64(p: *const u8) -> u64 {
    let mut n=0u64;
    for i in 0..8 { n |= (*p.add(i) as u64) << (8*i); }
    n
}
#[no_mangle]
pub unsafe extern "C" fn entrypoint(input: *mut u8) -> u64 {
    if read_u64(input) != 0 { return 1; }
    let input_len=read_u64(input.add(8));
    if input_len != BEND_LIBRARY_INPUT_BYTES as u64 { return 2; }
    let mut output=[0xa5u8; BEND_LIBRARY_OUTPUT_BYTES];
    let mut length=0u64;
    let status=bend_library_call(input.add(16),input_len,output.as_mut_ptr(),output.len() as u64,&mut length);
    if status != 0 { return 100+status as u64; }
    if length != output.len() as u64 { return 3; }
    sol_set_return_data(output.as_ptr(),length);
    0
}
