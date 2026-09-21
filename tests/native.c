#include <stdio.h>
#include "escrow.h"

int main(void) {
  unsigned authorized, tag, lo, hi;
  while (scanf("%u %u %u %u", &authorized, &tag, &lo, &hi) == 4) {
    if (authorized > 1 || tag > 1) return 1;
    bend_escrow_2e_Amount_t amount = bend_escrow_2e_Amount_make(lo, hi);
    bend_escrow_2e_Escrow_t before = tag == 0 ? bend_escrow_2e_Locked_make(amount)
      : bend_escrow_2e_Released_make(amount);
    bend_escrow_2e_Escrow_t after = bend_escrow_2e_release(authorized, before);
    bend_escrow_2e_Amount_t value = after.tag == 0 ? after.as.c0.f0 : after.as.c1.f0;
    printf("%u %u %u\n", after.tag, value.as.c0.f0, value.as.c0.f1);
  }
  return ferror(stdin) ? 1 : 0;
}
