//! Independent Rust arithmetic for the AMM comparison.
//!
//! Match the documented protocol, including upward-rounded fees and rejection
//! precedence. This module uses native u128 arithmetic; it does not include or
//! call the Bend compiler's generated code. The SBF adapter in main.rs uses
//! these functions; shared fixtures compare both complete programs.

pub type Checked = Result<u64, u32>;

fn positive(value: u64) -> Checked {
    if value == 0 {
        Err(4)
    } else {
        Ok(value)
    }
}

fn ceiling(product: u128, divisor: u64) -> Checked {
    if divisor == 0 {
        return Err(3);
    }
    let divisor = u128::from(divisor);
    let quotient = product / divisor + u128::from(product % divisor != 0);
    u64::try_from(quotient).map_err(|_| 1)
}

pub fn fee(amount: u64) -> Checked {
    ceiling(u128::from(amount) * 30, 10_000)
}

pub fn swap(input: u64, output: u64, gross: u64) -> Checked {
    positive(input)?;
    positive(output)?;
    positive(gross)?;
    input.checked_add(gross).ok_or(1u32)?;
    let effective = positive(gross.checked_sub(fee(gross)?).ok_or(2u32)?)?;
    let denominator = input.checked_add(effective).ok_or(1u32)?;
    let amount = u128::from(output) * u128::from(effective) / u128::from(denominator);
    positive(u64::try_from(amount).map_err(|_| 1u32)?)
}

pub fn deposit(reserve: u64, shares: u64, supply: u64) -> Checked {
    positive(reserve)?;
    positive(shares)?;
    positive(supply)?;
    positive(ceiling(u128::from(reserve) * u128::from(shares), supply)?)
}

pub fn withdraw(reserve: u64, shares: u64, supply: u64) -> Checked {
    positive(reserve)?;
    positive(shares)?;
    if shares >= supply {
        return Err(4);
    }
    let amount = u128::from(reserve) * u128::from(shares) / u128::from(supply);
    positive(u64::try_from(amount).map_err(|_| 1u32)?)
}

/// Newton iteration starts above every representable root. The initial sum is
/// at most 2^65-1, so neither the iteration nor its convergence test overflows.
pub fn sqrt(value: u128) -> u64 {
    if value < 2 {
        return value as u64;
    }
    let mut root = 1u128 << 64;
    loop {
        let next = (root + value / root) / 2;
        if next >= root {
            return root as u64;
        }
        root = next;
    }
}

pub fn geometric_mean(a: u64, b: u64) -> u64 {
    sqrt(u128::from(a) * u128::from(b))
}
