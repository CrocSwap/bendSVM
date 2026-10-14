"""Finite native cross-check of the staged C interpreter, not a C semantics proof."""
import copy,json,pathlib,hashlib,subprocess,os,sys
import z3 as z
sys.path.insert(0,'verification')
from acyclic_c import C,Source
root=pathlib.Path('build/acyclic-lowering');base=json.loads(pathlib.Path(json.loads((root/'fresh-receipt.json').read_text())['inputArtifact']).read_text())['programs'][1]
values=[0,1,2,7,15,31,32,255,65535,2147483647,2147483648,4294967295]
expressions=[
 'a0','~a0','a0 + 4294967295u','a0 - 1u','a0 * 2147483649u',
 'a0 << 31u','a0 >> 31u','a0 << (a0 & 31u)','a0 >> (a0 & 31u)',
 'a0 | 3u ^ 5u & 7u','a0 + 1u << 2u','a0 < 2147483648u',
 'a0 <= 2147483648u','a0 > 2147483648u','a0 >= 2147483648u',
 'a0 == 0u','a0 != 0u','!a0','!!a0',
 '(a0 == 0u) + 1u','1u - (a0 != 0u)',
 '(a0 == 0u) ? (a0 != 7u) : 42u',
 '(a0 == 0u) ? 42u : (a0 != 7u)',
 'a0 && 7u','a0 || 0u','(bend_u32)(a0 != 0u) << 31u',
 '0u && (a0 << 32u)','1u || (a0 << 32u)',
 '0u ? (a0 << 32u) : a0','1u ? a0 : (a0 << 32u)',
]
rows=[];needle='return bend_Present_3c_U32_3e__make(a0);'
for i,expression in enumerate(expressions):
 p=copy.deepcopy(base);a=p['artifact'];a['c']=a['c'].replace(needle,'return bend_Present_3c_U32_3e__make('+expression+');');a['cSha256']=hashlib.sha256(a['c'].encode()).hexdigest()
 source=Source(p['source']);predicted=[]
 for value in values:
  c=C(source,a);result=z.simplify(c.call('bend_present',[z.BitVecVal(value,32)],z.BoolVal(True)))
  assert all(z.is_false(z.simplify(guard)) for guard in c.bad),(expression,value,'unexpected model guard')
  predicted.append(z.simplify(result.arg(0)).as_long())
 path=root/f'expression-{i}.c';binary=path.with_suffix('.out')
 harness='\n#include <stdio.h>\nint main(void) { bend_u32 values[] = {'+', '.join(str(v)+'u' for v in values)+'}; for (unsigned i=0; i<sizeof(values)/sizeof(values[0]); ++i) { bend_Choice_3c_U32_3e__t r = bend_present(values[i]); if (r.tag != 1u) return 1; printf("%u\\n", r.as.c1.f0); } return 0; }\n'
 path.write_text(a['c']+harness)
 compiled=subprocess.run([os.environ.get('CC','clang'),'-std=c11','-O1','-fsanitize=undefined','-fno-sanitize-recover=all',str(path),'-o',str(binary)],capture_output=True,text=True,timeout=30)
 assert compiled.returncode==0,compiled.stderr
 native=subprocess.run([str(binary)],capture_output=True,text=True,timeout=5);assert native.returncode==0,native.stderr
 observed=[int(v) for v in native.stdout.splitlines()];assert observed==predicted,(expression,observed,predicted)
 rows.append({'expression':expression,'inputs':values,'expected':predicted,'native':observed,'cSha256':a['cSha256']})
report={'passed':True,'expressions':len(rows),'nativeCases':len(rows)*len(values),'sanitizer':'undefined; no recovery','rows':rows,
 'checkerSha256':hashlib.sha256(pathlib.Path('verification/acyclic_c.py').read_bytes()).hexdigest(),'scope':__doc__}
(root/'expression-differential.json').write_text(json.dumps(report,indent=2)+'\n');print(f'{len(rows)} expressions / {len(rows)*len(values)} native sanitizer cases matched the C model')
