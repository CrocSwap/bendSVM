/* SBPFv3 static-syscall trampolines. The shared runtime declares Solana
 * syscalls as externs (resolved by the v0 loader). For SBPFv3 builds this
 * translation unit defines each one as a call through its Murmur3-32 key,
 * which Clang -mcpu=v3 encodes as a static syscall (`call imm`, src 0).
 * Keys must match compiler/sbpf-v3-final-image.ts. */
typedef unsigned char u8;
typedef unsigned long long u64;
#define BEND_SYSCALL(hash, type) ((type)(hash##UL))
__attribute__((visibility("hidden"))) void sol_set_return_data(const u8 *data, u64 length) {
  BEND_SYSCALL(0xa226d3eb, void (*)(const u8 *, u64))(data, length); }
__attribute__((visibility("hidden"))) u64 sol_get_clock_sysvar(void *clock) {
  return BEND_SYSCALL(0xd56b5fe9, u64 (*)(void *))(clock); }
__attribute__((visibility("hidden"))) u64 sol_try_find_program_address(const void *seeds, int count, const u8 *program, u8 *key, u8 *bump) {
  return BEND_SYSCALL(0x48504a38, u64 (*)(const void *, int, const u8 *, u8 *, u8 *))(seeds, count, program, key, bump); }
__attribute__((visibility("hidden"))) u64 sol_invoke_signed_c(const void *ix, const void *infos, int count, const void *seeds, int seed_count) {
  return BEND_SYSCALL(0xa22b9c85, u64 (*)(const void *, const void *, int, const void *, int))(ix, infos, count, seeds, seed_count); }
__attribute__((visibility("hidden"))) void sol_memcpy_(void *dst, const void *src, u64 n) {
  BEND_SYSCALL(0x717cc4a3, void (*)(void *, const void *, u64))(dst, src, n); }
__attribute__((visibility("hidden"))) void sol_memmove_(void *dst, const void *src, u64 n) {
  BEND_SYSCALL(0x434371f8, void (*)(void *, const void *, u64))(dst, src, n); }
__attribute__((visibility("hidden"))) void sol_memset_(void *dst, u8 value, u64 n) {
  BEND_SYSCALL(0x3770fb22, void (*)(void *, u8, u64))(dst, value, n); }
__attribute__((visibility("hidden"))) u64 sol_sha256(const u8 *vals, u64 count, u8 *out) {
  return BEND_SYSCALL(0x11f49d86, u64 (*)(const u8 *, u64, u8 *))(vals, count, out); }
__attribute__((visibility("hidden"))) void sol_log_64_(u64 a, u64 b, u64 c, u64 d, u64 e) {
  BEND_SYSCALL(0x5c2a3178, void (*)(u64, u64, u64, u64, u64))(a, b, c, d, e); }
__attribute__((visibility("hidden"), noreturn)) void abort(void) {
  BEND_SYSCALL(0xb6fc1a11, void (*)(void))(); __builtin_unreachable(); }
