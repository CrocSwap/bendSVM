"""Positive, unpinned composition child. Qualification is owned by the controller."""
import sys
sys.path.insert(0,'verification')
from multi_token_composition.common import begin,finish
from multi_token_composition.model import analyse_fixture
if len(sys.argv)!=3:raise ValueError('usage: symbolic.py INPUT OUTPUT')
data,binding,out=begin(*sys.argv[1:]);rows=[]
for fixture in data['fixtures']:
 rows.append(analyse_fixture(fixture))
 print(fixture['name']+' positive composition passed',flush=True)
finish(data,binding,out,'positive',rows)
