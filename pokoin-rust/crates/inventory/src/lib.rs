use thiserror::Error;

/// A positive stock count. Zero is sold out, not a quantity you can decrement by.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quantity(u32);

#[derive(Debug, Error)]
#[error("quantity must be a positive integer")]
pub struct InvalidQuantity;

impl Quantity {
    pub fn new(value: i64) -> Result<Self, InvalidQuantity> {
        if (1..=99).contains(&value) {
            Ok(Self(value as u32))
        } else {
            Err(InvalidQuantity)
        }
    }

    pub fn get(self) -> u32 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListingStatus {
    Active,
    SoldOut,
    Inactive,
}

impl ListingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::SoldOut => "sold_out",
            Self::Inactive => "inactive",
        }
    }
}
