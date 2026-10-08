//! Compatibility facade for EqoBoard's existing JSON market-data contracts.
//!
//! New cross-repository wire contracts are owned by `trading-core/market-contracts`.
//! These legacy DTOs retain their existing shape, including floating-point fields, and
//! must not be treated as exact-decimal archival or execution contracts.

pub use market_contracts::legacy::{
    parse_occ, Bar, ContractError, MarketEvent, OccContract, OptionSnapshot, Right, StockSnapshot,
};
