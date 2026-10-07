//! Fail-closed, broker-neutral order gateway; never places live orders.
use async_trait::async_trait;
use chrono::{Duration as ChronoDuration, NaiveDate, Utc};
use eqo_domain::{parse_occ, Right};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Hash, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Broker {
    Alpaca,
    Ibkr,
    Schwab,
}
impl Broker {
    pub fn name(self) -> &'static str {
        match self {
            Self::Alpaca => "alpaca",
            Self::Ibkr => "ibkr",
            Self::Schwab => "schwab",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Environment {
    Paper,
    Live,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OrderKind {
    Stock,
    Option,
    Vertical,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Buy,
    Sell,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NetEffect {
    Debit,
    Credit,
}

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

/// The verified identity that created a preview. Both values are issuer-scoped:
/// OIDC subjects are not globally unique without their issuer.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct PreviewOwner {
    pub identity_issuer: String,
    pub subject: String,
}

impl PreviewOwner {
    pub fn new(identity_issuer: String, subject: String) -> Self {
        Self {
            identity_issuer,
            subject,
        }
    }
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
    #[error("preview does not belong to the authenticated identity")]
    NotOwner,
    #[error("broker adapter is not configured")]
    MissingAdapter,
    #[error("broker rejected the order")]
    Rejected,
    #[error("order state uncertain: reconcile by client_order_id before retry")]
    UnknownState,
}

#[derive(Clone, Copy)]
pub struct RiskPolicy {
    pub max_qty: u32,
    pub max_loss: f64,
}
impl RiskPolicy {
    pub fn from_env() -> Self {
        let max_qty = std::env::var("EQO_MAX_ORDER_QTY")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(10);
        let max_loss = std::env::var("EQO_MAX_ORDER_NOTIONAL")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1000.0);
        Self { max_qty, max_loss }
    }
}

const OPTION_CONTRACT_MULTIPLIER: i64 = 100;
const MONEY_MILLIS_PER_DOLLAR: i64 = 1_000;
const MONEY_MILLIS_PER_CENT: i64 = 10;
const MAX_SAFE_INTEGER: u128 = 9_007_199_254_740_991;

#[derive(Clone, Debug)]
struct StandardOptionContract {
    underlying: String,
    expiration: NaiveDate,
    right: Right,
    strike_millis: i64,
}

pub fn validate_order(intent: &OrderIntent, risk: RiskPolicy) -> Result<f64, OrderError> {
    validate_order_at(intent, risk, Utc::now().date_naive())
}

/// Validate against a caller-controlled date so expiry rules are deterministic in tests and replays.
pub fn validate_order_at(
    intent: &OrderIntent,
    risk: RiskPolicy,
    as_of: NaiveDate,
) -> Result<f64, OrderError> {
    if intent.environment != Environment::Paper {
        return Err(OrderError::LiveForbidden);
    }
    if intent.quantity == 0 || intent.quantity > risk.max_qty {
        return Err(OrderError::RiskLimit);
    }
    let limit_cents = decimal_to_integer_units(intent.limit_price, 100).ok_or(
        OrderError::Invalid("limit price must be positive whole cents"),
    )?;
    let limit_millis = limit_cents
        .checked_mul(MONEY_MILLIS_PER_CENT)
        .ok_or(OrderError::RiskLimit)?;
    let max_loss_millis = decimal_to_integer_units(risk.max_loss, MONEY_MILLIS_PER_DOLLAR)
        .filter(|max_loss| *max_loss > 0)
        .ok_or(OrderError::RiskLimit)?;
    let loss_millis = match intent.kind {
        OrderKind::Stock => {
            let symbol = intent
                .symbol
                .as_deref()
                .ok_or(OrderError::Invalid("stock symbol required"))?;
            if !valid_stock_symbol(symbol)
                || !intent.legs.is_empty()
                || intent.net_effect != NetEffect::Debit
            {
                return Err(OrderError::Invalid("stock order format"));
            }
            checked_order_risk_millis(limit_millis, 1, intent.quantity)?
        }
        OrderKind::Option => {
            if intent.legs.len() != 1
                || intent.legs[0].side != Side::Buy
                || intent.net_effect != NetEffect::Debit
                || intent.symbol.is_some()
            {
                return Err(OrderError::Invalid(
                    "standalone options must be buy-to-open",
                ));
            }
            let contract = parse_standard_option(&intent.legs[0].symbol)?;
            validate_expiration(contract.expiration, as_of)?;
            checked_order_risk_millis(limit_millis, OPTION_CONTRACT_MULTIPLIER, intent.quantity)?
        }
        OrderKind::Vertical => {
            if intent.legs.len() != 2
                || intent.symbol.is_some()
                || intent.legs.iter().filter(|l| l.side == Side::Buy).count() != 1
            {
                return Err(OrderError::Invalid(
                    "vertical needs one buy and one sell leg",
                ));
            }
            let buy_leg = intent
                .legs
                .iter()
                .find(|leg| leg.side == Side::Buy)
                .ok_or(OrderError::Invalid("vertical needs one buy leg"))?;
            let sell_leg = intent
                .legs
                .iter()
                .find(|leg| leg.side == Side::Sell)
                .ok_or(OrderError::Invalid("vertical needs one sell leg"))?;
            let long = parse_standard_option(&buy_leg.symbol)?;
            let short = parse_standard_option(&sell_leg.symbol)?;
            if long.underlying != short.underlying
                || long.expiration != short.expiration
                || long.right != short.right
            {
                return Err(OrderError::Invalid(
                    "legs must share underlying/expiry/right",
                ));
            }
            validate_expiration(long.expiration, as_of)?;
            let width_millis = long.strike_millis.abs_diff(short.strike_millis) as i64;
            if width_millis == 0 {
                return Err(OrderError::Invalid("vertical legs must differ by strike"));
            }
            if limit_millis >= width_millis {
                return Err(OrderError::Invalid(
                    "net limit must be less than spread width",
                ));
            }
            let inferred_effect = match long.right {
                Right::Call if long.strike_millis < short.strike_millis => NetEffect::Debit,
                Right::Call => NetEffect::Credit,
                Right::Put if long.strike_millis > short.strike_millis => NetEffect::Debit,
                Right::Put => NetEffect::Credit,
            };
            if intent.net_effect != inferred_effect {
                return Err(OrderError::Invalid(
                    "net effect conflicts with option type and long/short strike direction",
                ));
            }
            let signed_cashflow_millis = match inferred_effect {
                NetEffect::Debit => limit_millis.checked_neg().ok_or(OrderError::RiskLimit)?,
                NetEffect::Credit => limit_millis,
            };
            // Debit cashflow is negative and becomes the amount at risk. Credit
            // cashflow offsets the bounded strike-width liability.
            let max_loss_per_spread_millis = if signed_cashflow_millis < 0 {
                signed_cashflow_millis
                    .checked_neg()
                    .ok_or(OrderError::RiskLimit)?
            } else {
                width_millis
                    .checked_sub(signed_cashflow_millis)
                    .ok_or(OrderError::RiskLimit)?
            };
            checked_order_risk_millis(
                max_loss_per_spread_millis,
                OPTION_CONTRACT_MULTIPLIER,
                intent.quantity,
            )?
        }
    };
    if loss_millis > max_loss_millis {
        return Err(OrderError::RiskLimit);
    }
    if loss_millis <= 0 || loss_millis as u128 > MAX_SAFE_INTEGER {
        return Err(OrderError::RiskLimit);
    }
    let displayed_loss = loss_millis as f64 / MONEY_MILLIS_PER_DOLLAR as f64;
    if decimal_to_integer_units(displayed_loss, MONEY_MILLIS_PER_DOLLAR) != Some(loss_millis) {
        return Err(OrderError::RiskLimit);
    }
    Ok(displayed_loss)
}

/// Convert the shortest round-trippable decimal form of a JSON number into
/// fixed integer units without a magnitude-dependent floating-point tolerance.
fn decimal_to_integer_units(value: f64, scale: i64) -> Option<i64> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    let scale_power = decimal_power_of_ten(scale)?;
    let next = f64::from_bits(value.to_bits().checked_add(1)?);
    if !next.is_finite() || next - value > 1.0 / scale as f64 {
        return None;
    }
    let text = value.to_string();
    let (mantissa, exponent) = match text.find(['e', 'E']) {
        Some(index) => (&text[..index], text[index + 1..].parse::<i32>().ok()?),
        None => (text.as_str(), 0),
    };
    let decimal_places = mantissa
        .split_once('.')
        .map_or(0, |(_, fraction)| fraction.len());
    let digits: String = mantissa
        .chars()
        .filter(|character| *character != '.')
        .collect();
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let coefficient = digits.parse::<u128>().ok()?;
    if coefficient == 0 {
        return None;
    }
    let unit_shift = exponent
        .checked_sub(i32::try_from(decimal_places).ok()?)?
        .checked_add(scale_power)?;
    let units = if unit_shift >= 0 {
        let factor = checked_power_of_ten(u32::try_from(unit_shift).ok()?)?;
        coefficient.checked_mul(factor)?
    } else {
        let divisor = checked_power_of_ten(unit_shift.unsigned_abs())?;
        if coefficient % divisor != 0 {
            return None;
        }
        coefficient / divisor
    };
    if units == 0 || units > MAX_SAFE_INTEGER {
        return None;
    }
    i64::try_from(units).ok()
}

fn decimal_power_of_ten(value: i64) -> Option<i32> {
    if value < 1 {
        return None;
    }
    let mut remaining = value;
    let mut power = 0;
    while remaining > 1 {
        if remaining % 10 != 0 {
            return None;
        }
        remaining /= 10;
        power += 1;
    }
    Some(power)
}

fn checked_power_of_ten(power: u32) -> Option<u128> {
    (0..power).try_fold(1_u128, |value, _| value.checked_mul(10))
}

fn checked_order_risk_millis(
    per_share_millis: i64,
    multiplier: i64,
    quantity: u32,
) -> Result<i64, OrderError> {
    per_share_millis
        .checked_mul(multiplier)
        .and_then(|amount| amount.checked_mul(i64::from(quantity)))
        .ok_or(OrderError::RiskLimit)
}

fn validate_expiration(expiration: NaiveDate, as_of: NaiveDate) -> Result<(), OrderError> {
    if expiration <= as_of {
        return Err(OrderError::Invalid(
            "option expiration must be after the validation date",
        ));
    }
    Ok(())
}

fn parse_standard_option(symbol: &str) -> Result<StandardOptionContract, OrderError> {
    let parsed = parse_occ(symbol).map_err(|_| OrderError::Invalid("invalid OCC leg"))?;
    let root_len = symbol.len().saturating_sub(15);
    let root = symbol
        .get(..root_len)
        .ok_or(OrderError::Invalid("invalid OCC root"))?;
    let strike_text = symbol
        .get(root_len + 7..)
        .ok_or(OrderError::Invalid("invalid OCC strike"))?;
    if root.is_empty() || root.len() > 6 || !root.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err(OrderError::Invalid(
            "only standard alphabetic option roots are supported",
        ));
    }
    if strike_text.len() != 8 || !strike_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(OrderError::Invalid("invalid OCC strike"));
    }
    let strike_millis = strike_text
        .parse::<i64>()
        .map_err(|_| OrderError::Invalid("invalid OCC strike"))?;
    if strike_millis <= 0 {
        return Err(OrderError::Invalid("invalid OCC strike"));
    }
    Ok(StandardOptionContract {
        underlying: parsed.underlying,
        expiration: parsed.expiration,
        right: parsed.right,
        strike_millis,
    })
}

fn valid_stock_symbol(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 12
        && s.bytes()
            .all(|c| c.is_ascii_uppercase() || c == b'.' || c == b'-')
}

/// Single-use server-side preview store; intent cannot be edited between preview and confirmation.
type PreviewEntry = (Instant, PreviewOwner, OrderIntent);

#[derive(Clone, Default)]
pub struct PreviewStore {
    inner: Arc<Mutex<HashMap<Uuid, PreviewEntry>>>,
}
impl PreviewStore {
    pub async fn create(
        &self,
        owner: PreviewOwner,
        intent: OrderIntent,
        policy: RiskPolicy,
    ) -> Result<PreviewResult, OrderError> {
        let loss = validate_order(&intent, policy)?;
        let id = Uuid::new_v4();
        let expires_at = (Utc::now() + ChronoDuration::seconds(60)).to_rfc3339();
        let mut locked = self.inner.lock().await;
        locked.retain(|_, (valid_until, _, _)| *valid_until > Instant::now());
        if locked.len() >= 1000 {
            return Err(OrderError::RiskLimit);
        }
        locked.insert(
            id,
            (
                Instant::now() + Duration::from_secs(60),
                owner,
                intent.clone(),
            ),
        );
        Ok(PreviewResult {
            preview_id: id,
            expires_at,
            estimated_max_loss: loss,
            currency: "USD",
            intent,
        })
    }
    pub async fn authorize(&self, id: Uuid, owner: &PreviewOwner) -> Result<(), OrderError> {
        let mut locked = self.inner.lock().await;
        let Some((valid_until, preview_owner, _)) = locked.get(&id) else {
            return Err(OrderError::Expired);
        };
        if *valid_until <= Instant::now() {
            locked.remove(&id);
            return Err(OrderError::Expired);
        }
        if preview_owner != owner {
            return Err(OrderError::NotOwner);
        }
        Ok(())
    }
    pub async fn consume(&self, id: Uuid, owner: &PreviewOwner) -> Result<OrderIntent, OrderError> {
        let mut locked = self.inner.lock().await;
        let Some((valid_until, preview_owner, _)) = locked.get(&id) else {
            return Err(OrderError::Expired);
        };
        if *valid_until <= Instant::now() {
            locked.remove(&id);
            return Err(OrderError::Expired);
        }
        if preview_owner != owner {
            return Err(OrderError::NotOwner);
        }
        let (_, _, intent) = locked.remove(&id).ok_or(OrderError::Expired)?;
        Ok(intent)
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
        let token = std::env::var(format!("{prefix}_TOKEN"))
            .ok()
            .filter(|value| !value.is_empty());
        Self::from_url(&raw, token, Duration::from_secs(8))
    }

    fn from_url(raw: &str, token: Option<String>, timeout: Duration) -> Option<Self> {
        if raw.trim().is_empty() {
            return None;
        }
        let parsed = Url::parse(raw).ok()?;
        let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
        if !((local && parsed.scheme() == "http") || parsed.scheme() == "https")
            || parsed.username() != ""
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return None;
        }
        Some(Self {
            client: reqwest::Client::builder().timeout(timeout).build().ok()?,
            base: raw.trim_end_matches('/').to_string(),
            token,
        })
    }
}

fn validate_adapter_ack(id: Uuid, ack: AdapterAck) -> Result<AdapterAck, OrderError> {
    if ack.client_order_id != id.to_string() {
        return Err(OrderError::UnknownState);
    }
    match ack.status.as_str() {
        "accepted" => Ok(ack),
        "rejected" => Err(OrderError::Rejected),
        _ => Err(OrderError::UnknownState),
    }
}

#[async_trait]
impl BrokerAdapter for HttpBrokerAdapter {
    async fn submit(&self, id: Uuid, intent: &OrderIntent) -> Result<AdapterAck, OrderError> {
        let mut req = self
            .client
            .post(format!("{}/v1/orders", self.base))
            .header("X-Idempotency-Key", id.to_string())
            .json(&serde_json::json!({
                "schema_version": 1, "client_order_id": id.to_string(),
                "broker": intent.broker, "environment": "paper", "intent": intent
            }));
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        let response = req.send().await.map_err(|_| OrderError::UnknownState)?;
        if response.status() == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
            return Err(OrderError::Rejected);
        }
        if !response.status().is_success() {
            return Err(OrderError::UnknownState);
        }
        let ack: AdapterAck = response
            .json()
            .await
            .map_err(|_| OrderError::UnknownState)?;
        validate_adapter_ack(id, ack)
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
        Self::from_adapters(adapters)
    }
    pub fn from_adapters(adapters: HashMap<Broker, Arc<dyn BrokerAdapter>>) -> Self {
        Self {
            adapters: Arc::new(adapters),
        }
    }
    pub fn configured(&self) -> Vec<&'static str> {
        [Broker::Alpaca, Broker::Ibkr, Broker::Schwab]
            .into_iter()
            .filter(|b| self.adapters.contains_key(b))
            .map(Broker::name)
            .collect()
    }
    pub async fn submit(&self, id: Uuid, intent: &OrderIntent) -> Result<AdapterAck, OrderError> {
        let ack = self
            .adapters
            .get(&intent.broker)
            .ok_or(OrderError::MissingAdapter)?
            .submit(id, intent)
            .await?;
        validate_adapter_ack(id, ack)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        task::JoinHandle,
    };

    fn test_day() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, 7).unwrap()
    }

    async fn loopback_adapter_fixture(
        status: u16,
        delay: Duration,
        timeout: Duration,
        ack_status: Option<&str>,
        matching_id: bool,
    ) -> (Result<AdapterAck, OrderError>, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let id = Uuid::new_v4();
        let response_id = if matching_id {
            id.to_string()
        } else {
            "different-order-id".to_string()
        };
        let ack_status = ack_status.map(str::to_string);
        let server: JoinHandle<Vec<u8>> = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let mut chunk = [0_u8; 2048];
            loop {
                let count = stream.read(&mut chunk).await.unwrap();
                if count == 0 {
                    break;
                }
                received.extend_from_slice(&chunk[..count]);
                if received.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            tokio::time::sleep(delay).await;
            let body = ack_status
                .map(|ack_status| {
                    serde_json::json!({
                        "client_order_id": response_id,
                        "status": ack_status,
                        "broker_order_id": null,
                        "as_of": null
                    })
                    .to_string()
                })
                .unwrap_or_else(|| r#"{"error":"offline fixture"}"#.to_string());
            let reason = if status == 200 { "OK" } else { "Fixture" };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            received
        });
        let adapter =
            HttpBrokerAdapter::from_url(&format!("http://{address}"), None, timeout).unwrap();
        let result = adapter.submit(id, &vertical()).await;
        let request = server.await.unwrap();
        (result, String::from_utf8_lossy(&request).to_string())
    }

    fn option_symbol(expiration: NaiveDate, right: Right, strike_millis: i64) -> String {
        let right = match right {
            Right::Call => 'C',
            Right::Put => 'P',
        };
        format!(
            "QQQ{}{right}{strike_millis:08}",
            expiration.format("%y%m%d")
        )
    }

    fn vertical_for(
        expiration: NaiveDate,
        right: Right,
        long_strike_millis: i64,
        short_strike_millis: i64,
        net_effect: NetEffect,
        reverse_leg_order: bool,
    ) -> OrderIntent {
        let mut legs = vec![
            OrderLeg {
                symbol: option_symbol(expiration, right.clone(), long_strike_millis),
                side: Side::Buy,
            },
            OrderLeg {
                symbol: option_symbol(expiration, right, short_strike_millis),
                side: Side::Sell,
            },
        ];
        if reverse_leg_order {
            legs.reverse();
        }
        OrderIntent {
            broker: Broker::Ibkr,
            environment: Environment::Paper,
            kind: OrderKind::Vertical,
            symbol: None,
            quantity: 1,
            limit_price: 0.01,
            net_effect,
            legs,
        }
    }

    fn vertical() -> OrderIntent {
        vertical_for(
            test_day() + ChronoDuration::days(2),
            Right::Put,
            600_000,
            599_000,
            NetEffect::Debit,
            false,
        )
    }

    #[test]
    fn loss_and_live_guard() {
        let policy = RiskPolicy {
            max_qty: 3,
            max_loss: 250.0,
        };
        let order = vertical();
        assert_eq!(validate_order_at(&order, policy, test_day()).unwrap(), 1.0);
        let mut live = order.clone();
        live.environment = Environment::Live;
        assert!(matches!(
            validate_order_at(&live, policy, test_day()),
            Err(OrderError::LiveForbidden)
        ));
        let mut excessive = order;
        excessive.quantity = 4;
        assert!(matches!(
            validate_order_at(&excessive, policy, test_day()),
            Err(OrderError::RiskLimit)
        ));
    }

    #[test]
    fn blocks_naked_short_and_mixed_expiration() {
        let policy = RiskPolicy {
            max_qty: 20,
            max_loss: 100_000.0,
        };
        let mut order = vertical();
        order.legs[0].symbol = "QQQ261010P00600000".into();
        assert!(validate_order_at(&order, policy, test_day()).is_err());
        order.kind = OrderKind::Option;
        order.legs = vec![OrderLeg {
            symbol: option_symbol(test_day() + ChronoDuration::days(2), Right::Put, 600_000),
            side: Side::Sell,
        }];
        assert!(validate_order_at(&order, policy, test_day()).is_err());
    }

    #[test]
    fn fixed_point_conversion_rejects_subnormals_and_large_fractional_units() {
        assert_eq!(decimal_to_integer_units(0.01, 100), Some(1));
        assert_eq!(decimal_to_integer_units(0.29, 100), Some(29));
        assert_eq!(decimal_to_integer_units(0.001, 1_000), Some(1));
        assert_eq!(decimal_to_integer_units(f64::from_bits(1), 100), None);
        assert_eq!(decimal_to_integer_units(1e-15, 100), None);
        assert_eq!(decimal_to_integer_units(10_000_000_000_000.005, 100), None);
        assert_eq!(decimal_to_integer_units(90_000_000_000_000.0, 100), None);
        assert_eq!(decimal_to_integer_units(9_000_000_000_000.0, 1_000), None);
        assert_eq!(decimal_to_integer_units(f64::MAX, 100), None);
    }

    #[test]
    fn vertical_direction_matrix_derives_effect_and_integer_max_loss() {
        let expiration = test_day() + ChronoDuration::days(2);
        let policy = RiskPolicy {
            max_qty: 10,
            max_loss: 10_000.0,
        };
        let cases = [
            (Right::Call, 600_000, 620_000, NetEffect::Debit, 1.0),
            (Right::Call, 620_000, 600_000, NetEffect::Credit, 1_999.0),
            (Right::Put, 620_000, 600_000, NetEffect::Debit, 1.0),
            (Right::Put, 600_000, 620_000, NetEffect::Credit, 1_999.0),
        ];

        for (right, long, short, effect, expected_loss) in cases {
            for reverse_leg_order in [false, true] {
                let order = vertical_for(
                    expiration,
                    right.clone(),
                    long,
                    short,
                    effect,
                    reverse_leg_order,
                );
                assert_eq!(
                    validate_order_at(&order, policy, test_day()).unwrap(),
                    expected_loss
                );

                let mut conflicting = order;
                conflicting.net_effect = match effect {
                    NetEffect::Debit => NetEffect::Credit,
                    NetEffect::Credit => NetEffect::Debit,
                };
                assert!(matches!(
                    validate_order_at(&conflicting, policy, test_day()),
                    Err(OrderError::Invalid(_))
                ));
            }
        }
    }

    #[test]
    fn reported_issue_3_put_direction_is_rejected_and_correct_credit_exceeds_cap() {
        let expiration = test_day() + ChronoDuration::days(2);
        let policy = RiskPolicy {
            max_qty: 10,
            max_loss: 1_000.0,
        };
        let mut contradictory = vertical_for(
            expiration,
            Right::Put,
            600_000,
            620_000,
            NetEffect::Debit,
            false,
        );
        contradictory.limit_price = 0.01;
        assert!(matches!(
            validate_order_at(&contradictory, policy, test_day()),
            Err(OrderError::Invalid(_))
        ));

        contradictory.net_effect = NetEffect::Credit;
        assert!(matches!(
            validate_order_at(&contradictory, policy, test_day()),
            Err(OrderError::RiskLimit)
        ));
    }

    #[test]
    fn rejects_expiry_boundary_adjusted_roots_subcent_and_invalid_spread_bounds() {
        let policy = RiskPolicy {
            max_qty: 10,
            max_loss: 100_000.0,
        };
        let expiration = test_day() + ChronoDuration::days(2);
        let mut order = vertical();
        assert!(validate_order_at(&order, policy, test_day()).is_ok());
        assert!(matches!(
            validate_order_at(&order, policy, expiration + ChronoDuration::days(1)),
            Err(OrderError::Invalid(_))
        ));
        assert!(matches!(
            validate_order_at(&order, policy, expiration),
            Err(OrderError::Invalid(_))
        ));

        order.legs[0].symbol = "QQQ1261009P00600000".into();
        assert!(matches!(
            validate_order_at(&order, policy, test_day()),
            Err(OrderError::Invalid(_))
        ));
        order = vertical();
        order.limit_price = 0.015;
        assert!(matches!(
            validate_order_at(&order, policy, test_day()),
            Err(OrderError::Invalid(_))
        ));
        order.limit_price = 1.0;
        assert!(matches!(
            validate_order_at(&order, policy, test_day()),
            Err(OrderError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_cross_underlying_right_and_quantity_conflicts() {
        let expiration = test_day() + ChronoDuration::days(2);
        let policy = RiskPolicy {
            max_qty: 3,
            max_loss: 10_000.0,
        };
        let mut order = vertical();
        order.legs[1].symbol = format!("SPY{}P00599000", expiration.format("%y%m%d"));
        assert!(validate_order_at(&order, policy, test_day()).is_err());

        order = vertical();
        order.legs[1].symbol = option_symbol(expiration, Right::Call, 599_000);
        assert!(validate_order_at(&order, policy, test_day()).is_err());

        order = vertical();
        order.quantity = 0;
        assert!(matches!(
            validate_order_at(&order, policy, test_day()),
            Err(OrderError::RiskLimit)
        ));
        order.quantity = 4;
        assert!(matches!(
            validate_order_at(&order, policy, test_day()),
            Err(OrderError::RiskLimit)
        ));
    }

    #[tokio::test]
    async fn preview_single_use() {
        let store = PreviewStore::default();
        let policy = RiskPolicy {
            max_qty: 3,
            max_loss: 250.0,
        };
        let owner = PreviewOwner::new("https://identity.example".into(), "owner-a".into());
        let other_subject = PreviewOwner::new("https://identity.example".into(), "owner-b".into());
        let other_issuer =
            PreviewOwner::new("https://another-identity.example".into(), "owner-a".into());
        let preview_order = vertical_for(
            Utc::now().date_naive() + ChronoDuration::days(2),
            Right::Put,
            600_000,
            599_000,
            NetEffect::Debit,
            false,
        );
        let preview = store
            .create(owner.clone(), preview_order, policy)
            .await
            .unwrap();
        assert!(matches!(
            store.consume(preview.preview_id, &other_subject).await,
            Err(OrderError::NotOwner)
        ));
        assert!(matches!(
            store.authorize(preview.preview_id, &other_issuer).await,
            Err(OrderError::NotOwner)
        ));
        assert!(store.consume(preview.preview_id, &owner).await.is_ok());
        assert!(matches!(
            store.consume(preview.preview_id, &owner).await,
            Err(OrderError::Expired)
        ));
    }

    #[tokio::test]
    async fn uncertain_http_statuses_keep_the_order_outcome_unknown() {
        for status in [408, 409, 429, 500, 503] {
            let id = Uuid::new_v4();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = vec![0_u8; 8192];
                let count = stream.read(&mut request).await.unwrap();
                let response = format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                stream.write_all(response.as_bytes()).await.unwrap();
                String::from_utf8_lossy(&request[..count]).to_string()
            });
            let adapter = HttpBrokerAdapter::from_url(
                &format!("http://{address}"),
                None,
                Duration::from_secs(1),
            )
            .unwrap();
            assert!(matches!(
                adapter.submit(id, &vertical()).await,
                Err(OrderError::UnknownState)
            ));
            let request = server.await.unwrap();
            assert!(request
                .to_ascii_lowercase()
                .contains(&format!("x-idempotency-key: {id}")));
        }
    }

    #[tokio::test]
    async fn only_unprocessable_entity_is_a_definite_http_rejection() {
        let (result, _) =
            loopback_adapter_fixture(422, Duration::ZERO, Duration::from_secs(1), None, true).await;
        assert!(matches!(result, Err(OrderError::Rejected)));
    }

    #[tokio::test]
    async fn loopback_adapter_timeout_is_unknown() {
        let (result, request) = loopback_adapter_fixture(
            200,
            Duration::from_millis(100),
            Duration::from_millis(20),
            Some("accepted"),
            true,
        )
        .await;
        assert!(matches!(result, Err(OrderError::UnknownState)));
        assert!(request.to_ascii_lowercase().contains("x-idempotency-key:"));
    }

    #[tokio::test]
    async fn loopback_adapter_requires_a_matching_id_and_known_ack_state() {
        let (accepted, _) = loopback_adapter_fixture(
            200,
            Duration::ZERO,
            Duration::from_secs(1),
            Some("accepted"),
            true,
        )
        .await;
        assert!(accepted.is_ok());

        let (rejected, _) = loopback_adapter_fixture(
            200,
            Duration::ZERO,
            Duration::from_secs(1),
            Some("rejected"),
            true,
        )
        .await;
        assert!(matches!(rejected, Err(OrderError::Rejected)));

        for (ack_status, matching_id) in [
            (Some("working"), true),
            (Some("accepted"), false),
            (None, true),
        ] {
            let (uncertain, _) = loopback_adapter_fixture(
                200,
                Duration::ZERO,
                Duration::from_secs(1),
                ack_status,
                matching_id,
            )
            .await;
            assert!(matches!(uncertain, Err(OrderError::UnknownState)));
        }
    }
}
