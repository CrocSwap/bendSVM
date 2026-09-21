import ../sdk/context.bend as Sol
import ../sdk/cpi.bend as Cpi

# Compact two-call executor probe: both calls use the same capability, but
# distinct byte payloads. No application authorization is claimed.
type State is Data:
  State{count: U32}

type Instruction is Data:
  Run{effect: Cpi.Effect, second_data: Cpi.Bytes64}

type Outcome is Data:
  Accepted{state: State, effects: Cpi.Effects}
  Rejected{code: U32}

def with_data(effect: Cpi.Effect, data: Cpi.Bytes64) -> Cpi.Effect:
  match effect:
    case Cpi.None{}:
      Cpi.None{}
    case Cpi.Invoke{program, program_key, length, old_data, count, accounts}:
      Cpi.Invoke{program, program_key, length, data, count, accounts}

def pair(+effect: Cpi.Effect, data: Cpi.Bytes64) -> Cpi.Effects:
  Cpi.Effects{effect, with_data(effect, data)}

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match state instruction:
    case State{count} Run{effect, second_data}:
      Accepted{State{U32.add(count, 1)}, pair(effect, second_data)}
