/* LLVM can emit these libc helpers for larger aggregate copies/initializers,
 * even in freestanding mode. Route them to Solana's bounded memory syscalls. */
typedef __SIZE_TYPE__ size_t;
extern void sol_memcpy_(void *, const void *, unsigned long long);
extern void sol_memmove_(void *, const void *, unsigned long long);
extern void sol_memset_(void *, unsigned char, unsigned long long);
__attribute__((visibility("hidden")))
void *memcpy(void *dst, const void *src, size_t n) { sol_memcpy_(dst,src,n); return dst; }
__attribute__((visibility("hidden")))
void *memmove(void *dst, const void *src, size_t n) { sol_memmove_(dst,src,n); return dst; }
__attribute__((visibility("hidden")))
void *memset(void *dst, int value, size_t n) { sol_memset_(dst,(unsigned char)value,n); return dst; }
