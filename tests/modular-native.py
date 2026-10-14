"""Independent integer oracle and sanitizer replay of emitted arithmetic C."""
import json,pathlib,sys,math,hashlib,subprocess,os
sys.path.insert(0,'verification')
from modular_report import validate,sha,snapshot,need,RECIPES
receipt=json.loads(pathlib.Path('build/modular-lowering/fresh-receipt.json').read_text());raw=pathlib.Path(receipt['inputArtifact']).read_bytes();need(sha(raw)==receipt['inputSha256'],'input hash');data=json.loads(raw)
rpath=pathlib.Path(receipt['reportArtifact']);need(sha(rpath.read_bytes())==receipt['reportSha256'],'report hash');report=json.loads(rpath.read_text());validate(report,data,raw);run=rpath.parent
values=sorted({0,1,2,3,(1<<128)-1,*[max(0,min((1<<128)-1,(1<<n)+d)) for n in range(129) for d in [-1,0,1]]})
pairs=[(0,0),(0,(1<<64)-1),((1<<64)-1,(1<<64)-1),(1<<32,1<<32),(7,11)]
lines=[]
for x in values:
 limbs=[(x>>(32*i))&0xffffffff for i in range(4)];expected=math.isqrt(x)
 lines.append('r=bend_floor(bend_wide_2e_U128_make(bend_math_2e_U64_make(%du,%du),bend_math_2e_U64_make(%du,%du)));'%tuple(limbs))
 lines.append('if(r.as.c0.f0!=%du || r.as.c0.f1!=%du)return 42;'%(expected&0xffffffff,expected>>32))
for a,b in pairs:
 expected=math.isqrt(a*b)
 lines.append('r=bend_geometric_5f_mean(bend_math_2e_U64_make(%du,%du),bend_math_2e_U64_make(%du,%du));'%(a&0xffffffff,a>>32,b&0xffffffff,b>>32))
 lines.append('if(r.as.c0.f0!=%du || r.as.c0.f1!=%du)return 42;'%(expected&0xffffffff,expected>>32))
original=data['programs'][0]['artifact']['c'];units=[('original',original)]
for row,(_,name,old,new,target) in zip(report['mutations'][:4],RECIPES[:4]):
 c=original.replace(old,new);need(sha(c.encode())==row['cSha256'],'mutation hash');units.append((name,c))
rows=[];cc=os.environ.get('CC','clang');version=subprocess.run([cc,'--version'],capture_output=True,text=True,check=True).stdout
for name,c in units:
 source=run/(name+'-oracle.c');exe=run/(name+'-oracle')
 source.write_text(c+'\nint main(void){volatile bend_u32 a=5u,b=0u;if(bend_U32_2e_div(a,b)!=0u)return 43; bend_math_2e_U64_t r;\n'+'\n'.join(lines)+'\nreturn 0;}\n')
 command=[cc,'-std=c11','-O1','-g','-fsanitize=address,undefined','-fno-sanitize-recover=all',str(source),'-o',str(exe)]
 compiled=subprocess.run(command,capture_output=True,text=True,timeout=60);compile_log=run/(name+'-compile.log');compile_log.write_text(compiled.stdout+compiled.stderr);need(compiled.returncode==0,'native compilation failed')
 result=subprocess.run([str(exe)],capture_output=True,text=True,timeout=10);log=run/(name+'-oracle.log');log.write_text(result.stdout+result.stderr)
 if name=='unguarded-divide':need(result.returncode!=0 and 'division by zero' in result.stderr,'missing UB detection')
 else:need(result.returncode==(0 if name=='original' else 42) and not result.stderr,'wrong native outcome '+name)
 rows.append({'name':name,'cSha256':sha(c.encode()),'harness':str(source),'harnessSha256':sha(source.read_bytes()),'binary':str(exe),'binarySha256':sha(exe.read_bytes()),'exitCode':result.returncode,'log':str(log),'logSha256':sha(log.read_bytes()),'compileLog':str(compile_log),'compileLogSha256':sha(compile_log.read_bytes()),'command':command})
need(snapshot(data['sourceHashes'])==data['sourceHashes'],'source drift')
(run/'native-arithmetic.json').write_text(json.dumps({'passed':True,'reportSha256':receipt['reportSha256'],'compilerVersion':version,'floorCases':len(values),'meanCases':len(pairs),'divisionZeroCase':True,'results':rows},indent=2)+'\n')
print('Native arithmetic oracle and all four sanitizer/fault controls passed')
