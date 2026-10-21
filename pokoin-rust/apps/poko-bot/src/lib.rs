//! Telegram and Discord front for Poko. The brain and profile link live on the
//! Pokoin API; this process only speaks HTTP plus the two chat gateways.

pub mod api;
pub mod config;
pub mod connect;
pub mod discord;
pub mod discord_context;
pub mod format;
pub mod gate;
pub mod gateway_lock;
pub mod health;
pub mod hermes;
pub mod history;
pub mod invisible;
pub mod media;
pub mod redact;
pub mod telegram;
pub mod turn;

pub const APOLOGY: &str =
    "Sono Poko: ho ricevuto il messaggio, ma non sono riuscito a rispondere adesso.";
pub const WPKN_CONTRACT_ADDRESS: &str = "0x91A17E2bddfF839078BD395482B38e4AC15276f4";

pub fn contract_address_reply() -> String {
    format!("BNB Chain wPKN contract address:\n{WPKN_CONTRACT_ADDRESS}")
}
