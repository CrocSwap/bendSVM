"""Fresh-run binding checks around the staged child-report validator."""
from pathlib import Path
import json,sys
import bundle_report as b
if not __debug__:raise RuntimeError('fresh entry assertions required')
def validate(prepath,postpath):
 raw=Path(prepath).read_bytes();pre=json.loads(raw);post=json.loads(Path(postpath).read_bytes())
 b.need(set(pre)=={'version','runId','runDirectory','sources','prerequisites','nativeCompiler'},'pre-execution input inventory')
 b.need(set(post)==set(pre)|{'children'},'post-execution input inventory')
 b.need(all(post[k]==v for k,v in pre.items()),'pre/post input drift')
 b.need(Path(prepath)==Path(pre['runDirectory'])/'before.json','pre-execution path')
 b.need(Path(postpath)==Path(pre['runDirectory'])/'after.json','post-execution path')
 result=b.validate(post);b.need(Path(prepath).read_bytes()==raw,'pre-execution input changed')
 result.update({'beforeSha256':b.sha(raw),'afterSha256':b.sha(Path(postpath).read_bytes())});return result
if __name__=='__main__':print(json.dumps(validate(sys.argv[1],sys.argv[2])))
