//! Exact decimal amounts for EUR and PKN. Prices stay as ratios so
//! `eur / rate` does not drift through binary floats.

use std::cmp::Ordering;

#[derive(Clone, Copy, Debug, Eq)]
pub struct Rat {
    num: i128,
    den: i128,
}

impl PartialEq for Rat {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl PartialOrd for Rat {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Rat {
    fn cmp(&self, other: &Self) -> Ordering {
        match self
            .num
            .checked_mul(other.den)
            .zip(other.num.checked_mul(self.den))
        {
            Some((left, right)) => left.cmp(&right),
            None => (self.num as f64 / self.den as f64)
                .partial_cmp(&(other.num as f64 / other.den as f64))
                .unwrap_or(Ordering::Equal),
        }
    }
}

impl Rat {
    pub fn new(num: i128, den: i128) -> Option<Self> {
        if den == 0 {
            return None;
        }
        let (num, den) = if den < 0 { (-num, -den) } else { (num, den) };
        let factor = gcd(num.unsigned_abs(), den.unsigned_abs()) as i128;
        Some(Self {
            num: num / factor,
            den: den / factor,
        })
    }

    pub fn quotient(self, other: Self) -> Option<Self> {
        Self::new(
            self.num.checked_mul(other.den)?,
            self.den.checked_mul(other.num)?,
        )
    }

    pub fn is_positive(self) -> bool {
        self.num > 0
    }
}

fn gcd(mut a: u128, mut b: u128) -> u128 {
    while b != 0 {
        let rest = a % b;
        a = b;
        b = rest;
    }
    a.max(1)
}

/// `PKN_CHECKOUT_USDT_PRICE` when it is a positive number, otherwise 0.005.
pub fn checkout_rate(raw: Option<&str>) -> Rat {
    let fallback = Rat::new(5, 1000).expect("0.005");
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return fallback;
    };
    match parse_rat(raw) {
        Some(rate) if rate.is_positive() => rate,
        _ => fallback,
    }
}

pub fn price_to_pkn(eur: Rat, rate: Rat) -> Option<Rat> {
    eur.quotient(rate)
}

pub fn parse_rat(raw: &str) -> Option<Rat> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    let (negative, text) = if let Some(rest) = text.strip_prefix('-') {
        (true, rest)
    } else if let Some(rest) = text.strip_prefix('+') {
        (false, rest)
    } else {
        (false, text)
    };
    let (body, exponent) = match text.split_once(['e', 'E']) {
        Some((body, exp)) => (body, exp.parse::<i32>().ok()?),
        None => (text, 0),
    };
    let (whole, frac) = match body.split_once('.') {
        Some((whole, frac)) => (whole, frac),
        None => (body, ""),
    };
    if !whole.is_empty() && !whole.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if !frac.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if whole.is_empty() && frac.is_empty() {
        return None;
    }
    let digits = if whole.is_empty() {
        format!("0{frac}")
    } else {
        format!("{whole}{frac}")
    };
    let mut num: i128 = digits.parse().ok()?;
    if negative {
        num = -num;
    }
    let scale = frac.len() as i32 - exponent;
    if scale >= 0 {
        Rat::new(num, 10i128.checked_pow(scale as u32)?)
    } else {
        Rat::new(num.checked_mul(10i128.checked_pow((-scale) as u32)?)?, 1)
    }
}

/// Decimal text with trailing zeros removed. Terminating ratios stay exact.
pub fn format_rat(rat: Rat) -> String {
    let negative = rat.num < 0;
    let den = rat.den.unsigned_abs();
    let whole = rat.num.unsigned_abs() / den;
    let mut rem = rat.num.unsigned_abs() % den;
    let mut digits = String::new();
    for _ in 0..24 {
        if rem == 0 {
            break;
        }
        rem = rem.saturating_mul(10);
        digits.push(char::from_digit((rem / den) as u32, 10).unwrap_or('0'));
        rem %= den;
    }
    while digits.ends_with('0') {
        digits.pop();
    }
    let mut text = if digits.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{digits}")
    };
    if negative {
        text.insert(0, '-');
    }
    text
}
