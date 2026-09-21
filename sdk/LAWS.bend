import ./math.bend as Math

# These laws prove the checked API's guard behavior. They do not yet prove the
# bit-level algorithms refine unbounded integer arithmetic for every input.
law add_accepts:
  for +a: Math.U64
  for +b: Math.U64
  for e: {Math.less(Math.add_wrap(a, b), a) == False{} : Bool}
  {Math.add(a, b) == Math.Ok{Math.add_wrap(a, b)} : Math.Checked}

law add_rejects:
  for +a: Math.U64
  for +b: Math.U64
  for e: {Math.less(Math.add_wrap(a, b), a) == True{} : Bool}
  {Math.add(a, b) == Math.Err{1} : Math.Checked}

law sub_accepts:
  for +a: Math.U64
  for +b: Math.U64
  for e: {Math.less(a, b) == False{} : Bool}
  {Math.sub(a, b) == Math.Ok{Math.sub_wrap(a, b)} : Math.Checked}

law sub_rejects:
  for +a: Math.U64
  for +b: Math.U64
  for e: {Math.less(a, b) == True{} : Bool}
  {Math.sub(a, b) == Math.Err{2} : Math.Checked}

law div_zero:
  for a: Math.U64
  {Math.div(a, Math.zero()) == Math.Err{3} : Math.Checked}

law mod_zero:
  for a: Math.U64
  {Math.mod(a, Math.zero()) == Math.Err{3} : Math.Checked}
