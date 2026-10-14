import runpy
if not __debug__:raise RuntimeError('entry proof assertions required')
ns=runpy.run_path('verification/collection_entry/binding-domain.py',run_name='__main__')
runpy.run_path('verification/collection_entry/check-summary-bindings.py',run_name='__main__',init_globals={'qualified_entry':ns['e']})
runpy.run_path('verification/collection_entry/metadata-controls.py',run_name='__main__',init_globals={'qualified_metadata':ns['m']})
