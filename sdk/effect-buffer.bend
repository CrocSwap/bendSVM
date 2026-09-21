import ./buffer.bend as B
import ./issuance.bend as Fx

# Reusable four-slot, runtime-length token effect vector.
def empty() -> B.Vector<Fx.Effect, B.Pair<B.Pair<Fx.Effect>>>:
  B.Vector{0, B.Pair{B.Pair{Fx.None{}, Fx.None{}}, B.Pair{Fx.None{}, Fx.None{}}}}

def write(storage: B.Pair<B.Pair<Fx.Effect>>, index: U32, effect: Fx.Effect) -> B.Pair<B.Pair<Fx.Effect>>:
  B.quad_set(Fx.Effect, storage, index, effect)

def push(vector: B.Vector<Fx.Effect, B.Pair<B.Pair<Fx.Effect>>>, effect: Fx.Effect) -> B.Result<B.Vector<Fx.Effect, B.Pair<B.Pair<Fx.Effect>>>>:
  B.push(Fx.Effect, B.Pair<B.Pair<Fx.Effect>>, 4, write, vector, effect)

def one(effect: Fx.Effect) -> B.Vector<Fx.Effect, B.Pair<B.Pair<Fx.Effect>>>:
  B.Vector{1, B.Pair{B.Pair{effect, Fx.None{}}, B.Pair{Fx.None{}, Fx.None{}}}}
