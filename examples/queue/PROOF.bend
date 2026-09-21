import ./LAWS.bend as Laws
import ../../sdk/PROOF.bend as MathProof

def Laws.closed_is_terminal(context, instruction, metadata, window):
  {==}

def Laws.unauthorized_is_rejected(phase, queue, instruction, metadata, window):
  {==}

def Laws.invalid_append_is_rejected(queue, obligation, window):
  {==}

def Laws.invalid_fold_is_rejected(queue, page, window):
  {==}

def Laws.conservation_is_required(state, window, length, effects):
  {==}

def Laws.arithmetic_error_persists(amount, code):
  {==}
