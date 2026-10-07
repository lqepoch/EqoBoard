//! Fail-closed, broker-neutral order gateway; never places live orders.
use async_trait::async_trait;
use chrono::{Duration as ChronoDuration, Utc};
use eqo_domain::{parse_occ, Right};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc, time::{Duration, Instant}};
use thiserror::Error;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Hash, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Broker { Alpaca, Ibkr, Schwab }
impl Broker {
    pub fn name(self) -> &'static str { match self { Self::Alpaca => "alpaca", Self::Ibkr => "ibkr", Self::Schwab => "schwab" } }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Environment { Paper, Live }
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OrderKind { Stock, Option, Vertical }
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Side { Buy, Sell }
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NetEffect { Debit, Credit }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OrderLeg {
    pub symbol: String,
    pub side: Side,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OrderIntent {
    pub broker: Broker,
    pub environment: Environment,
    pub kind: OrderKind,
    pub symbol: Option<String>,
    pub quantity: u32,
    pub limit_price: f64,
    pub net_effect: NetEffect,
    #[serde(default)]
    pub legs: Vec<OrderLeg>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PreviewResult {
    pub preview_id: Uuid,
    pub expires_at: String,
    pub estimated_max_loss: f64,
    pub currency: &'static str,
    pub intent: OrderIntent,
}

#[derive(Debug, Error)]
pub enum OrderError {
    #[error("only Paper execution is supported")]
    LiveForbidden,
    #[error("execution disabled")]
    Disabled,
    #[error("invalid order intent: {0}")]
    Invalid(&'static str),
    #[error("order exceeds configured risk bounds")]
    RiskLimit,
    #[error("preview expired or already consumed")]
    Expired,
    #[error("broker adapter is not configured")]
    MissingAdapter,
    #[error("broker rejected the order")]
    Rejected,
    #[error("order state uncertain: reconcile by client_order_id before retry")]
    UnknownState,
}

#[derive(Clone, Copy)]
pub struct RiskPolicy { pub max_qty: u32, pub max_loss: f64 }
impl RiskPolicy {
    pub fn from_env() -> Self {
        let max_qty = std::env::var("EQO_MAX_ORDER_QTY")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(10);
        let max_loss = std::env::var("EQO_MAX_ORDER_NOTIONAL")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(1000.0);
        Self { max_qty, max_loss }
    }
}

pub fn validate_order(intent: &OrderIntent, risk: RiskPolicy) -> Result<f64, OrderError> {
    if intent.environment != Environment::Paper { return Err(OrderError::LiveForbidden) }
    if intent.quantity == 0 || intent.quantity > risk.max_qty {
        return Err(OrderError::RiskLimit)
    }
    if !intent.limit_price.is_finite() || intent.limit_price <= 0.0 {
        return Err(OrderError::Invalid("limit price must be positive and finite"))
    }
    let q = f64::from(intent.quantity);
    let loss = match intent.kind {
        OrderKind::Stock => {
            let symbol = intent.symbol.as_deref().ok_or(OrderError::Invalid("stock symbol required"))?;
            if !valid_stock_symbol(symbol) || !intent.legs.is_empty() || intent.net_effect != NetEffect::Debit {
                return Err(OrderError::Invalid("stock order format"))
            }
            intent.limit_price * q
        },
        OrderKind::Option => {
            if intent.legs.len() != 1 || intent.legs[0].side != Side::Buy
                || intent.net_effect != NetEffect::Debit || intent.symbol.is_some()
            {
                return Err(OrderError::Invalid("standalone options must be buy-to-open"))
            }
            parse_occ(&intent.legs[0].symbol).map_err(|_| OrderError::Invalid("invalid option symbol"))?;
            intent.limit_price * 100.0 * q
        },
        OrderKind::Vertical => {
            if intent.legs.len() != 2 || intent.symbol.is_some() ||
                intent.legs.iter().filter(|l| l.side == Side::Buy).count() != 1 {
                return Err(OrderError::Invalid("vertical needs one buy and one sell leg"))
            }
            let a = parse_occ(&intent.legs[0].symbol).map_err(|_| OrderError::Invalid("invalid OCC leg"))?;
            let b = parse_occ(&intent.legs[1].symbol).map_err(|_| OrderError::Invalid("invalid OCC leg"))?;
            if a.underlying != b.underlying || a.expiration != b.expiration ||
                a.right != b.right || (a.strike - b.strike).abs() < 0.00001 {
                return Err(OrderError::Invalid("legs must share underlying/expiry/right and differ by strike"))
            }
            let width = (a.strike - b.strike).abs();
            if intent.limit_price >= width {
                return Err(OrderError::Invalid("net limit must be less than spread width"))
            }
            let max_loss_per_spread = match intent.net_effect {
                NetEffect::Debit => intent.limit_price,
                NetEffect::Credit => width - intent.limit_price,
            };
            max_loss_per_spread * 100.0 * q
        }
    };
    if !loss.is_finite() || !risk.max_loss.is_finite() || loss > risk.max_loss || risk.max_loss <= 0.0 {
        return Err(OrderError::RiskLimit)
    }
    Ok(loss)
}

fn valid_stock_symbol(s: &str) -> bool {
    !s.is_empty() && s.len() <= 12 &&
        s.bytes().all(|c| c.is_ascii_uppercase() || c == b'.' || c == b'-')
}

/// Single-use server-side preview store; intent cannot be edited between preview and confirmation.
#[derive(Clone, Default)]
pub struct PreviewStore { inner: Arc<Mutex<HashMap<Uuid, (Instant, OrderIntent)>>> }
impl PreviewStore {
    pub async fn create(&self, intent: OrderIntent, policy: RiskPolicy)
        -> Result<PreviewResult, OrderError> {
        let loss = validate_order(&intent, policy)?;
        let id = Uuid::new_v4();
        let expires_at = (Utc::now() + ChronoDuration::seconds(60)).to_rfc3339();
        let mut locked = self.inner.lock().await;
        locked.retain(|_, (valid_until, _)| *valid_until > Instant::now());
        if locked.len() >= 1000 { return Err(OrderError::RiskLimit) }
        locked.insert(id, (Instant::now() + Duration::from_secs(60), intent.clone()));
        Ok(PreviewResult { preview_id: id, expires_at, estimated_max_loss: loss, currency: "USD", intent })
    }
    pub async fn consume(&self, id: Uuid) -> Result<OrderIntent, OrderError> {
        let item = self.inner.lock().await.remove(&id).ok_or(OrderError::Expired)?;
        if item.0 <= Instant::now() { return Err(OrderError::Expired) }
        Ok(item.1)
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AdapterAck {
    pub client_order_id: String,
    pub status: String,
    pub broker_order_id: Option<String>,
    pub as_of: Option<String>,
}

#[async_trait]
pub trait BrokerAdapter: Send + Sync {
    async fn submit(&self, id: Uuid, intent: &OrderIntent) -> Result<AdapterAck, OrderError>;
}

struct HttpBrokerAdapter {
    client: reqwest::Client,
    base: String,
    token: Option<String>,
}

impl HttpBrokerAdapter {
    fn from_env(name: &str) -> Option<Self> {
        let prefix = format!("EQO_ADAPTER_{}", name.to_uppercase());
        let raw = std::env::var(format!("{prefix}_URL")).ok()?;
        if raw.trim().is_empty() { return None }
        let parsed = Url::parse(&raw).ok()?;
        let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
        if !((local && parsed.scheme() == "http") || parsed.scheme() == "https")
            || parsed.username() != "" || parsed.password().is_some() ||
            parsed.query().is_some() || parsed.fragment().is_some() {
            return None
        }
        Some(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(8))
                .build().ok()?,
            base: raw.trim_end_matches('/').to_string(),
            token: std::env::var(format!("{prefix}_TOKEN")).ok().filter(|v| !v.is_empty()),
        })
    }
}

#[async_trait]
impl BrokerAdapter for HttpBrokerAdapter {
    async fn submit(&self, id: Uuid, intent: &OrderIntent) -> Result<AdapterAck, OrderError> {
        let mut req = self.client.post(format!("{}/v1/orders", self.base))
            .header("X-Idempotency-Key", id.to_string())
            .json(&serde_json::json!({
                "schema_version": 1, "client_order_id": id.to_string(),
                "broker": intent.broker, "environment": "paper", "intent": intent
            }));
        if let Some(token) = &self.token { req = req.bearer_auth(token); }
        let response = req.send().await.map_err(|_| OrderError::UnknownState)?;
        if response.status().is_client_error() { return Err(OrderError::Rejected) }
        if !response.status().is_success() { return Err(OrderError::UnknownState) }
        let ack: AdapterAck = response.json().await.map_err(|_| OrderError::UnknownState)?;
        if ack.client_order_id != id.to_string() { return Err(OrderError::UnknownState) }
        Ok(ack)
    }
}

#[derive(Clone, Default)]
pub struct BrokerRouter {
    adapters: Arc<HashMap<Broker, Arc<dyn BrokerAdapter>>>,
}
impl BrokerRouter {
    pub fn from_env() -> Self {
        let mut adapters: HashMap<Broker, Arc<dyn BrokerAdapter>> = HashMap::new();
        for broker in [Broker::Alpaca, Broker::Ibkr, Broker::Schwab] {
            if let Some(adapter) = HttpBrokerAdapter::from_env(broker.name()) {
                adapters.insert(broker, Arc::new(adapter));
            }
        }
        Self { adapters: Arc::new(adapters) }
    }
    pub fn configured(&self) -> Vec<&'static str> {
        [Broker::Alpaca, Broker::Ibkr, Broker::Schwab].into_iter()
            .filter(|b| self.adapters.contains_key(b)).map(Broker::name).collect()
    }
    pub async fn submit(&self, id: Uuid, intent: &OrderIntent) -> Result<AdapterAck, OrderError> {
        self.adapters.get(&intent.broker).ok_or(OrderError::MissingAdapter)?
            .submit(id, intent).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn vertical() -> OrderIntent {
        OrderIntent { broker: Broker::Ibkr, environment: Environment::Paper,
            kind: OrderKind::Vertical, symbol: None, quantity: 1,
            limit_price: 0.92, net_effect: NetEffect::Debit,
            legs: vec![
                OrderLeg { symbol: "QQQ261007P00600000".into(), side: Side::Buy },
                OrderLeg { symbol: "QQQ261007P00599000".into(), side: Side::Sell }
            ],
        }
    }
    #[test]
    fn loss_and_live_guard() {
        let policy = RiskPolicy { max_qty: 3, max_loss: 250.0 };
        let order = vertical();
        assert_eq!(validate_order(&order, policy).unwrap(), 92.0);
        let mut live = order.clone();
        live.environment = Environment::Live;
        assert!(matches!(validate_order(&live, policy), Err(OrderError::LiveForbidden)));
        let mut excessive = order;
        excessive.quantity = 4;
        assert!(matches!(validate_order(&excessive, policy), Err(OrderError::RiskLimit)));
    }
    #[test]
    fn blocks_naked_short_and_mixed_expiration() {
        let policy = RiskPolicy { max_qty: 20, max_loss: 100_000.0 };
        let mut order = vertical();
        order.legs[0].symbol = "QQQ261009P00600000".into();
        assert!(validate_order(&order, policy).is_err());
        order.kind = OrderKind::Option;
        order.legs = vec![OrderLeg { symbol: "QQQ261007P00600000".into(), side: Side::Sell }];
        assert!(validate_order(&order, policy).is_err());
    }
    #[tokio::test]
    async fn preview_single_use() {
        let store = PreviewStore::default();
        let policy = RiskPolicy { max_qty: 3, max_loss: 250.0 };
        let preview = store.create(vertical(), policy).await.unwrap();
        assert!(store.consume(preview.preview_id).await.is_ok());
        assert!(matches!(store.consume(preview.preview_id).await, Err(OrderError::Expired)));
    }
}
