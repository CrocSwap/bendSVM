import path from 'node:path';
export function nativeSource(stem: string): string {
  return `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "${path.basename(stem)}.dispatch.h"
int main(void) {
  unsigned length, capacity, byte;
  while (scanf("%u %u", &length, &capacity) == 2) {
    if (length > 1024 || capacity > 1024) return 1;
    unsigned char *input = malloc(length ? length : 1);
    unsigned char *output = malloc(capacity ? capacity : 1);
    if (!input || !output) return 2;
    for (unsigned i = 0; i < length; ++i) {
      if (scanf("%u", &byte) != 1 || byte > 255) return 3;
      input[i] = (unsigned char)byte;
    }
    memset(output, 0xa5, capacity ? capacity : 1);
    unsigned long long written = 777;
    int ok = bend_wire_dispatch(input, length, output, capacity, &written);
    if (!ok && written != 0) return 4;
    printf("%d", ok);
    if (ok) for (unsigned long long i = 0; i < written; ++i) printf(" %u", output[i]);
    puts("");
    free(input); free(output);
  }
  return ferror(stdin) ? 5 : 0;
}
`;
}


export function bindingContext(schema: any) {
 function zero(name: string): any {
  const t=schema.types.find((t: any)=>t.name===name);
  if(t.kind==='u32') return 0;
  if(t.kind==='bool') return false;
  const v=t.variants[0];
  return {constructor:v.name,fields:Object.fromEntries(v.fields.map((f: any)=>[f.name,zero(f.type)]))};
 }
 return {zero};
}
