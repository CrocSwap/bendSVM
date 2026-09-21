//! Independent implementation of the batch protocol; no Bend-generated logic.
pub type Key = [u8; 32];
#[derive(Clone, Copy)]
pub struct Obligation {
    pub recipient: Key,
    pub amount: u64,
}
#[derive(Clone, Copy)]
pub struct Batch {
    pub owner: Key,
    pub mint: Key,
    pub vault: Key,
    pub length: u32,
    pub obligations: [Obligation; 4],
    pub fuel: u32,
    pub total: u64,
}
#[derive(Clone, Copy)]
pub enum State {
    Empty,
    Funded(Batch),
    Closed,
}
#[derive(Clone, Copy)]
pub enum Instruction {
    Initialize {
        mint: Key,
        vault: Key,
        length: u32,
        obligations: [Obligation; 4],
        fuel: u32,
    },
    Settle,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Authority {
    Actor,
    Custody,
}
#[derive(Clone, Copy)]
pub enum Effect {
    None,
    Transfer {
        source: usize,
        destination: usize,
        mint: usize,
        mint_key: Key,
        recipient: Option<Key>,
        amount: u64,
        authority: Authority,
        source_key: Option<Key>,
        destination_key: Option<Key>,
    },
}
fn total(batch: &Batch, bounds_error: u32) -> Result<u64, u32> {
    if batch.length > 4 || batch.fuel != batch.length {
        return Err(bounds_error);
    }
    let mut total = 0u64;
    for obligation in &batch.obligations[..batch.length as usize] {
        if obligation.amount == 0 {
            return Err(3);
        }
        total = total.checked_add(obligation.amount).ok_or(4u32)?;
    }
    Ok(total)
}
pub fn process(
    signed: bool,
    actor: Key,
    state: State,
    instruction: Instruction,
) -> Result<(State, [Effect; 4]), u32> {
    match (state, instruction) {
        (
            State::Empty,
            Instruction::Initialize {
                mint,
                vault,
                length,
                obligations,
                fuel,
            },
        ) => {
            if !signed {
                return Err(1);
            }
            let mut batch = Batch {
                owner: actor,
                mint,
                vault,
                length,
                obligations,
                fuel,
                total: 0,
            };
            batch.total = total(&batch, 3)?;
            if batch.total == 0 {
                return Err(3);
            }
            let mut effects = [Effect::None; 4];
            effects[0] = Effect::Transfer {
                source: 4,
                destination: 5,
                mint: 6,
                mint_key: mint,
                recipient: None,
                amount: batch.total,
                authority: Authority::Actor,
                source_key: None,
                destination_key: Some(vault),
            };
            Ok((State::Funded(batch), effects))
        }
        (State::Funded(batch), Instruction::Settle) => {
            if !signed || actor != batch.owner {
                return Err(1);
            }
            let sum = total(&batch, 5)?;
            if sum == 0 || sum != batch.total {
                return Err(6);
            }
            let mut effects = [Effect::None; 4];
            for (i, obligation) in batch.obligations[..batch.length as usize]
                .iter()
                .enumerate()
            {
                effects[i] = Effect::Transfer {
                    source: 4,
                    destination: 6 + i,
                    mint: 5,
                    mint_key: batch.mint,
                    recipient: Some(obligation.recipient),
                    amount: obligation.amount,
                    authority: Authority::Custody,
                    source_key: Some(batch.vault),
                    destination_key: None,
                };
            }
            Ok((State::Closed, effects))
        }
        _ => Err(2),
    }
}
