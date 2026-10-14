import ./mixed.bend as Mixed

law disabled_requests_are_refused:
  for value: U32
  {Mixed.evaluate(Mixed.Run{False{}, value}) == Mixed.Refused{value} : Mixed.Decision}

law stop_requests_are_refused:
  {Mixed.evaluate(Mixed.Stop{}) == Mixed.Refused{0} : Mixed.Decision}

law enabled_requests_use_the_41_cutoff:
  for value: U32
  {Mixed.evaluate(Mixed.Run{True{}, value}) == Mixed.decide(U32.is_lt(value, 41), value) : Mixed.Decision}

law true_decision_is_accepted:
  for value: U32
  {Mixed.decide(True{}, value) == Mixed.Accepted{U32.add(value, 2)} : Mixed.Decision}

law false_decision_is_refused:
  for value: U32
  {Mixed.decide(False{}, value) == Mixed.Refused{value} : Mixed.Decision}

law enabled_boundary_40_is_accepted:
  {Mixed.evaluate(Mixed.Run{True{}, 40}) == Mixed.Accepted{42} : Mixed.Decision}

law enabled_boundary_41_is_refused:
  {Mixed.evaluate(Mixed.Run{True{}, 41}) == Mixed.Refused{41} : Mixed.Decision}
