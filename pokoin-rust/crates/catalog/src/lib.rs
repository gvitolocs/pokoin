use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardId(String);

#[derive(Debug, Error)]
#[error("card id is empty")]
pub struct InvalidCardId;

impl CardId {
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidCardId> {
        let value = value.into().trim().to_string();
        if value.is_empty() {
            return Err(InvalidCardId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}
