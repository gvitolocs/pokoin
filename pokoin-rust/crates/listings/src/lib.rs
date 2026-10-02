use pokoin_inventory::ListingStatus;
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserId(String);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListingId(String);

impl UserId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl ListingId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Same predicate as the Node `DECREMENT_SQL`: lock the row, then update only
/// for this seller when enough quantity remains.
pub const DECREMENT_SQL: &str = r#"
with locked as (
  select id, seller_uid, quantity_available
  from public.marketplace_user_listings
  where id = $1
  for update
),
updated as (
  update public.marketplace_user_listings as listing
  set
    quantity_available = listing.quantity_available - $3,
    status = case
      when listing.quantity_available - $3 = 0 then 'sold_out'
      else listing.status
    end,
    updated_at = now()
  from locked
  where listing.id = locked.id
    and locked.seller_uid = $2
    and locked.quantity_available >= $3
  returning listing.*
)
select
  case
    when exists (select 1 from updated) then 'updated'
    when not exists (select 1 from locked) then 'missing'
    when exists (select 1 from locked where seller_uid is distinct from $2) then 'forbidden'
    else 'insufficient'
  end as outcome,
  (select row_to_json(updated) from updated) as listing
"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecrementOutcome {
    Updated,
    Missing,
    Forbidden,
    Insufficient,
    Invalid,
}

impl DecrementOutcome {
    pub fn parse(value: &str) -> Self {
        match value {
            "updated" => Self::Updated,
            "forbidden" => Self::Forbidden,
            "insufficient" => Self::Insufficient,
            "invalid" => Self::Invalid,
            _ => Self::Missing,
        }
    }

    pub fn http_status(self) -> u16 {
        match self {
            Self::Invalid => 400,
            Self::Missing | Self::Forbidden => 404,
            Self::Insufficient => 409,
            Self::Updated => 200,
        }
    }
}

#[derive(Debug, Error)]
pub enum ListingError {
    #[error("not the owner")]
    Forbidden,
    #[error("not enough quantity")]
    Insufficient,
}

pub fn next_status(remaining: i64) -> ListingStatus {
    if remaining == 0 {
        ListingStatus::SoldOut
    } else {
        ListingStatus::Active
    }
}
