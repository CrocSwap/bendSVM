import ./LAWS.bend as Laws
import ./math.bend as Math

def Laws.add_accepts(a, b, e):
  %Equal.sym(Bool, Math.less(Math.add_wrap(a, b), a), False{}, e) : {Math.add_result(_, Math.add_wrap(a, b)) == Math.Ok{Math.add_wrap(a, b)} : Math.Checked}
  {==}

def Laws.add_rejects(a, b, e):
  %Equal.sym(Bool, Math.less(Math.add_wrap(a, b), a), True{}, e) : {Math.add_result(_, Math.add_wrap(a, b)) == Math.Err{1} : Math.Checked}
  {==}

def Laws.sub_accepts(a, b, e):
  %Equal.sym(Bool, Math.less(a, b), False{}, e) : {Math.sub_result(_, a, b) == Math.Ok{Math.sub_wrap(a, b)} : Math.Checked}
  {==}

def Laws.sub_rejects(a, b, e):
  %Equal.sym(Bool, Math.less(a, b), True{}, e) : {Math.sub_result(_, a, b) == Math.Err{2} : Math.Checked}
  {==}

def Laws.div_zero(a):
  {==}

def Laws.mod_zero(a):
  {==}
