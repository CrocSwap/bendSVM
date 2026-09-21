import ./effects.bend as Fx

# Three atomic token effects, for operations that need an additional token leg.
# All legs are validated before the first CPI; state commits after all succeed.
# This record does not change the existing two-effect SDK interface.
type Effects is Data:
  Effects{first: Fx.Effect, second: Fx.Effect, third: Fx.Effect}

def none() -> Effects:
  Effects{Fx.None{}, Fx.None{}, Fx.None{}}
