//! Alpaca market data source. SIP / OPRA feeds are explicit; no silent fallback.
use chrono::{Duration as ChronoDuration, Utc};
use eqo_domain::{parse_occ, Bar, MarketEvent, OptionSnapshot, StockSnapshot};
use futures_util::{SinkExt, StreamExt};
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::{broadcast, watch};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};
use tracing::{error, info, warn};

const ALPACA_MARKET_DATA_BASE: &str = "https://data.alpaca.markets";
const MAX_BAR_PAGES: usize = 5;
const MAX_OPTION_PAGES: usize = 5;

#[derive(Debug, Error)]
pub enum DataError {
    #[error("missing Alpaca API credentials")]
    MissingCredentials,
    #[error("Alpaca market data request failed with HTTP {0}")]
    Http(u16),
    #[error("invalid upstream response")]
    InvalidResponse,
    #[error("Alpaca transport unavailable")]
    Transport,
}

impl DataError {
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::MissingCredentials => StatusCode::SERVICE_UNAVAILABLE,
            Self::Http(401) => StatusCode::UNAUTHORIZED,
            Self::Http(403) => StatusCode::FORBIDDEN,
            Self::Http(429) => StatusCode::TOO_MANY_REQUESTS,
            Self::Http(_) | Self::Transport => StatusCode::BAD_GATEWAY,
            Self::InvalidResponse => StatusCode::BAD_GATEWAY,
        }
    }
}

#[derive(Clone)]
pub struct AlpacaData {
    client: reqwest::Client,
    key: String,
    secret: String,
    pub stock_feed: String,
    pub option_feed: String,
    base: String,
    stream_base: String,
}

pub struct ChainPage {
    pub contracts: Vec<OptionSnapshot>,
    pub pages_fetched: usize,
    pub has_more: bool,
    pub truncated: bool,
    pub limit: usize,
}

pub struct BarsPage {
    pub bars: Vec<Bar>,
    pub pages_fetched: usize,
    pub has_more: bool,
    pub truncated: bool,
    pub limit: usize,
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn timestamp(value: &Value, key: &str) -> Option<String> {
    text(value, key).filter(|time| chrono::DateTime::parse_from_rfc3339(time).is_ok())
}

fn parse_bar(value: &Value) -> Result<Bar, DataError> {
    Ok(Bar {
        time: timestamp(value, "t").ok_or(DataError::InvalidResponse)?,
        open: number(value, "o").ok_or(DataError::InvalidResponse)?,
        high: number(value, "h").ok_or(DataError::InvalidResponse)?,
        low: number(value, "l").ok_or(DataError::InvalidResponse)?,
        close: number(value, "c").ok_or(DataError::InvalidResponse)?,
        volume: number(value, "v").ok_or(DataError::InvalidResponse)?,
    })
}

fn next_page_token(response: &Value) -> Result<Option<String>, DataError> {
    // Alpaca uses an absent/null token to end pagination and a nonempty opaque
    // string to continue. Treat an empty string or any other JSON type as malformed.
    match response.get("next_page_token") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(token)) if !token.is_empty() => Ok(Some(token.clone())),
        Some(Value::String(_)) => Err(DataError::InvalidResponse),
        Some(_) => Err(DataError::InvalidResponse),
    }
}

impl AlpacaData {
    pub fn from_env() -> Result<Self, DataError> {
        let key = std::env::var("ALPACA_KEY").unwrap_or_default();
        let secret = std::env::var("ALPACA_SECRET").unwrap_or_default();
        if key.trim().is_empty() || secret.trim().is_empty() {
            return Err(DataError::MissingCredentials);
        }
        let stock_feed = std::env::var("EQO_STOCK_FEED").unwrap_or_else(|_| "sip".into());
        let option_feed = std::env::var("EQO_OPTION_FEED").unwrap_or_else(|_| "opra".into());
        // Keep feeds explicit; source provenance is unknown for any endpoint override.
        if !["sip", "delayed_sip", "iex"].contains(&stock_feed.as_str())
            || !["opra", "indicative"].contains(&option_feed.as_str())
        {
            return Err(DataError::InvalidResponse);
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(12))
                .pool_max_idle_per_host(8)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| DataError::Transport)?,
            key,
            secret,
            stock_feed,
            option_feed,
            base: std::env::var("EQO_MARKET_DATA_BASE_URL")
                .unwrap_or_else(|_| ALPACA_MARKET_DATA_BASE.into())
                .trim_end_matches('/')
                .to_owned(),
            stream_base: std::env::var("EQO_MARKET_STREAM_BASE_URL")
                .unwrap_or_else(|_| "wss://stream.data.alpaca.markets".into())
                .trim_end_matches('/')
                .to_owned(),
        })
    }

    /// Reports the provider only when the built-in Alpaca endpoint is in use.
    /// Any endpoint override is unverified and must not be labeled Alpaca.
    pub fn source_mode(&self) -> &'static str {
        if self.base == ALPACA_MARKET_DATA_BASE {
            "alpaca"
        } else {
            "unknown"
        }
    }

    #[cfg(feature = "test-utils")]
    /// Creates a credential-free client for local mock HTTP tests.
    pub fn with_test_endpoint(base: impl Into<String>) -> Result<Self, DataError> {
        let base = base.into().trim_end_matches('/').to_owned();
        if !(base.starts_with("http://127.0.0.1:")
            || base.starts_with("http://localhost:")
            || base.starts_with("http://[::1]:"))
        {
            return Err(DataError::InvalidResponse);
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| DataError::Transport)?,
            key: "test-key".into(),
            secret: "test-secret".into(),
            stock_feed: "sip".into(),
            option_feed: "opra".into(),
            base,
            stream_base: "ws://127.0.0.1:0".into(),
        })
    }

    async fn get(&self, path: &str, params: &[(&str, String)]) -> Result<Value, DataError> {
        let response = self
            .client
            .get(format!("{}{}", self.base, path))
            .header("APCA-API-KEY-ID", &self.key)
            .header("APCA-API-SECRET-KEY", &self.secret)
            .query(params)
            .send()
            .await
            .map_err(|_| DataError::Transport)?;
        let status = response.status();
        if !status.is_success() {
            // Upstream body could contain account details. Do not reflect it to the browser.
            warn!(status = %status, "Alpaca data request rejected");
            return Err(DataError::Http(status.as_u16()));
        }
        response
            .json()
            .await
            .map_err(|_| DataError::InvalidResponse)
    }

    pub async fn stock_snapshots(
        &self,
        symbols: &[String],
    ) -> Result<Vec<StockSnapshot>, DataError> {
        let value = self
            .get(
                "/v2/stocks/snapshots",
                &[
                    ("symbols", symbols.join(",")),
                    ("feed", self.stock_feed.clone()),
                ],
            )
            .await?;
        let map = value.as_object().ok_or(DataError::InvalidResponse)?;
        let mut result = Vec::with_capacity(symbols.len());
        for symbol in symbols {
            let Some(snap) = map.get(symbol) else {
                continue;
            };
            let trade_price = number(&snap["latestTrade"], "p");
            let daily_close = number(&snap["dailyBar"], "c");
            let last = trade_price.or(daily_close);
            let last_basis = if trade_price.is_some() {
                Some("trade".into())
            } else if daily_close.is_some() {
                Some("daily_bar".into())
            } else {
                None
            };
            let trade_at = timestamp(&snap["latestTrade"], "t");
            let daily_bar_at = timestamp(&snap["dailyBar"], "t");
            let last_as_of = match last_basis.as_deref() {
                Some("trade") => trade_at.clone(),
                Some("daily_bar") => daily_bar_at.clone(),
                _ => None,
            };
            let previous_close = number(&snap["prevDailyBar"], "c");
            let change_percent = last
                .zip(previous_close)
                .and_then(|(a, b)| (b > 0.0).then_some((a / b - 1.0) * 100.0));
            result.push(StockSnapshot {
                symbol: symbol.clone(),
                last,
                open: number(&snap["dailyBar"], "o"),
                high: number(&snap["dailyBar"], "h"),
                low: number(&snap["dailyBar"], "l"),
                previous_close,
                change_percent,
                bid: number(&snap["latestQuote"], "bp"),
                ask: number(&snap["latestQuote"], "ap"),
                volume: number(&snap["dailyBar"], "v"),
                updated_at: trade_at,
                last_basis,
                last_as_of,
                quote_at: timestamp(&snap["latestQuote"], "t"),
                daily_bar_at,
                previous_daily_bar_at: timestamp(&snap["prevDailyBar"], "t"),
                feed: self.stock_feed.clone(),
            });
        }
        Ok(result)
    }

    pub async fn stock_bars(
        &self,
        symbol: &str,
        timeframe: &str,
        limit: usize,
        days: i64,
    ) -> Result<Vec<Bar>, DataError> {
        Ok(self
            .stock_bars_page(symbol, timeframe, limit, days)
            .await?
            .bars)
    }

    /// Fetches a bounded, chronologically ordered bar window and preserves whether
    /// Alpaca returned a continuation token after the requested limit/page budget.
    pub async fn stock_bars_page(
        &self,
        symbol: &str,
        timeframe: &str,
        limit: usize,
        days: i64,
    ) -> Result<BarsPage, DataError> {
        if limit == 0 {
            return Err(DataError::InvalidResponse);
        }
        // Descending order lets the bounded response contain the newest bars across weekends.
        let start = (Utc::now() - ChronoDuration::days(days)).to_rfc3339();
        let path = format!("/v2/stocks/{symbol}/bars");
        let mut out = Vec::with_capacity(limit);
        let mut page_token: Option<String> = None;
        let mut seen_page_tokens = HashSet::new();
        let mut pages_fetched = 0;
        let mut has_more = false;
        for _ in 0..MAX_BAR_PAGES {
            let remaining = limit.saturating_sub(out.len());
            if remaining == 0 {
                break;
            }
            if page_token
                .as_ref()
                .is_some_and(|token| !seen_page_tokens.insert(token.clone()))
            {
                return Err(DataError::InvalidResponse);
            }
            let mut params = vec![
                ("timeframe", timeframe.to_owned()),
                ("limit", remaining.min(1000).to_string()),
                ("sort", "desc".into()),
                ("start", start.clone()),
                ("feed", self.stock_feed.clone()),
            ];
            if let Some(token) = &page_token {
                params.push(("page_token", token.clone()));
            }
            let data = self.get(&path, &params).await?;
            let rows = data
                .get("bars")
                .and_then(Value::as_array)
                .ok_or(DataError::InvalidResponse)?;
            pages_fetched += 1;
            let overflow = rows.len() > remaining;
            let mut page_bars = Vec::with_capacity(rows.len().min(remaining));
            for row in rows.iter().take(remaining) {
                page_bars.push(parse_bar(row)?);
            }
            out.extend(page_bars);
            page_token = next_page_token(&data)?;
            has_more = page_token.is_some() || overflow;
            if !has_more || out.len() >= limit {
                break;
            }
        }
        out.reverse();
        Ok(BarsPage {
            bars: out,
            pages_fetched,
            has_more,
            truncated: has_more,
            limit,
        })
    }

    pub async fn option_chain(
        &self,
        underlying: &str,
        expiration: &str,
        strike_gte: Option<f64>,
        strike_lte: Option<f64>,
    ) -> Result<ChainPage, DataError> {
        let mut token: Option<String> = None;
        let mut seen_page_tokens = HashSet::new();
        let mut contracts = Vec::new();
        let mut truncated = false;
        let mut pages_fetched = 0;
        let mut has_more = false;
        for page in 0..MAX_OPTION_PAGES {
            if token
                .as_ref()
                .is_some_and(|token| !seen_page_tokens.insert(token.clone()))
            {
                return Err(DataError::InvalidResponse);
            }
            let mut params = vec![
                ("feed", self.option_feed.clone()),
                ("expiration_date", expiration.to_owned()),
                ("limit", "1000".into()),
            ];
            if let Some(value) = strike_gte {
                params.push(("strike_price_gte", value.to_string()));
            }
            if let Some(value) = strike_lte {
                params.push(("strike_price_lte", value.to_string()));
            }
            if let Some(value) = &token {
                params.push(("page_token", value.clone()));
            }
            let response = self
                .get(&format!("/v1beta1/options/snapshots/{underlying}"), &params)
                .await?;
            pages_fetched += 1;
            let snapshots = response
                .get("snapshots")
                .and_then(Value::as_object)
                .ok_or(DataError::InvalidResponse)?;
            for (symbol, s) in snapshots {
                let occ = parse_occ(symbol).map_err(|_| DataError::InvalidResponse)?;
                if occ.expiration.to_string() != expiration {
                    return Err(DataError::InvalidResponse);
                }
                let q = &s["latestQuote"];
                let g = &s["greeks"];
                contracts.push(OptionSnapshot {
                    symbol: symbol.clone(),
                    underlying: occ.underlying,
                    expiration: occ.expiration.to_string(),
                    right: occ.right,
                    strike: occ.strike,
                    bid: number(q, "bp"),
                    ask: number(q, "ap"),
                    last: number(&s["latestTrade"], "p"),
                    bid_size: number(q, "bs"),
                    ask_size: number(q, "as"),
                    iv: number(s, "impliedVolatility"),
                    delta: number(g, "delta"),
                    gamma: number(g, "gamma"),
                    theta: number(g, "theta"),
                    vega: number(g, "vega"),
                    updated_at: timestamp(q, "t").or_else(|| timestamp(&s["latestTrade"], "t")),
                    quote_at: timestamp(q, "t"),
                    trade_at: timestamp(&s["latestTrade"], "t"),
                    model_as_of: None,
                    feed: self.option_feed.clone(),
                });
            }
            token = next_page_token(&response)?;
            has_more = token.is_some();
            if !has_more {
                break;
            }
            if page + 1 == MAX_OPTION_PAGES {
                truncated = true
            }
        }
        contracts.sort_by(|a, b| {
            a.strike
                .total_cmp(&b.strike)
                .then_with(|| a.symbol.cmp(&b.symbol))
        });
        Ok(ChainPage {
            contracts,
            pages_fetched,
            has_more,
            truncated,
            limit: MAX_OPTION_PAGES * 1000,
        })
    }

    pub async fn stream(
        &self,
        is_option: bool,
        mut subscriptions: watch::Receiver<Vec<String>>,
        tx: broadcast::Sender<MarketEvent>,
    ) {
        let name = if is_option { "options" } else { "stocks" };
        let feed = if is_option {
            &self.option_feed
        } else {
            &self.stock_feed
        };
        let path = if is_option { "v1beta1" } else { "v2" };
        let url = format!("{}/{}/{}", self.stream_base, path, feed);
        let mut backoff = 1_u64;
        loop {
            let mut request = match url.as_str().into_client_request() {
                Ok(r) => r,
                Err(_) => {
                    error!("invalid Alpaca stream URL");
                    return;
                }
            };
            // Header authentication avoids replaying secrets through app messages.
            request.headers_mut().insert(
                "APCA-API-KEY-ID",
                match self.key.parse() {
                    Ok(h) => h,
                    Err(_) => {
                        error!("invalid API key header");
                        return;
                    }
                },
            );
            request.headers_mut().insert(
                "APCA-API-SECRET-KEY",
                match self.secret.parse() {
                    Ok(h) => h,
                    Err(_) => {
                        error!("invalid API secret header");
                        return;
                    }
                },
            );
            request.headers_mut().insert(
                "Content-Type",
                if is_option {
                    "application/msgpack".parse().expect("constant")
                } else {
                    "application/json".parse().expect("constant")
                },
            );
            let _ = tx.send(MarketEvent::FeedStatus {
                feed: name.into(),
                state: "connecting".into(),
                timestamp: Utc::now().to_rfc3339(),
            });
            match connect_async(request).await {
                Ok((mut socket, _)) => {
                    info!(feed = name, "market stream connected");
                    backoff = 1;
                    let mut active = HashSet::<String>::new();
                    // Subscribe exactly to current union; never use '*' for option quotes.
                    let wanted: HashSet<String> = subscriptions.borrow().iter().cloned().collect();
                    if !wanted.is_empty() {
                        if send_subscribe(&mut socket, "subscribe", &wanted, is_option)
                            .await
                            .is_err()
                        {
                            continue;
                        }
                        active = wanted;
                    }
                    let _ = tx.send(MarketEvent::FeedStatus {
                        feed: name.into(),
                        state: "connected".into(),
                        timestamp: Utc::now().to_rfc3339(),
                    });
                    loop {
                        tokio::select! {
                            change = subscriptions.changed() => {
                                if change.is_err() { return; }
                                let wanted: HashSet<String> = subscriptions.borrow().iter().cloned().collect();
                                let remove: HashSet<_> = active.difference(&wanted).cloned().collect();
                                let add: HashSet<_> = wanted.difference(&active).cloned().collect();
                                if !remove.is_empty() && send_subscribe(&mut socket, "unsubscribe", &remove, is_option).await.is_err() { break; }
                                if !add.is_empty() && send_subscribe(&mut socket, "subscribe", &add, is_option).await.is_err() { break; }
                                active = wanted;
                            },
                            incoming = socket.next() => {
                                match incoming {
                                    Some(Ok(Message::Text(t))) => forward_events(t.as_bytes(), false, is_option, &tx, name),
                                    Some(Ok(Message::Binary(b))) => forward_events(&b, true, is_option, &tx, name),
                                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                                    _ => {},
                                }
                            }
                        }
                    }
                }
                Err(err) => warn!(feed = name, error = %err, "market stream disconnected"),
            }
            let _ = tx.send(MarketEvent::FeedStatus {
                feed: name.into(),
                state: "disconnected".into(),
                timestamp: Utc::now().to_rfc3339(),
            });
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    }
}

async fn send_subscribe<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    action: &str,
    symbols: &HashSet<String>,
    _is_option: bool,
) -> Result<(), ()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut list: Vec<String> = symbols.iter().cloned().collect();
    list.sort();
    for chunk in list.chunks(200) {
        let msg = json!({"action": action, "quotes": chunk, "trades": chunk});
        socket
            .send(Message::Text(msg.to_string().into()))
            .await
            .map_err(|_| ())?;
    }
    Ok(())
}

fn forward_events(
    bytes: &[u8],
    binary: bool,
    is_option: bool,
    tx: &broadcast::Sender<MarketEvent>,
    name: &str,
) {
    let records: Result<Vec<Value>, _> = if binary {
        rmp_serde::from_slice(bytes).map_err(|_| ())
    } else {
        serde_json::from_slice(bytes).map_err(|_| ())
    };
    let Ok(records) = records else { return };
    for value in records {
        let category = value.get("T").and_then(Value::as_str).unwrap_or("");
        if category == "error" {
            let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
            warn!(feed = name, code, "Alpaca websocket error");
            let _ = tx.send(MarketEvent::FeedStatus {
                feed: name.into(),
                state: format!("error:{code}"),
                timestamp: Utc::now().to_rfc3339(),
            });
            continue;
        }
        let symbol = match value.get("S").and_then(Value::as_str) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let timestamp = text(&value, "t").unwrap_or_else(|| Utc::now().to_rfc3339());
        let event = match (category, is_option) {
            ("q", true) => Some(MarketEvent::OptionQuote {
                symbol,
                bid: number(&value, "bp"),
                ask: number(&value, "ap"),
                bid_size: number(&value, "bs"),
                ask_size: number(&value, "as"),
                timestamp,
            }),
            ("q", false) => Some(MarketEvent::StockQuote {
                symbol,
                bid: number(&value, "bp"),
                ask: number(&value, "ap"),
                timestamp,
            }),
            ("t", true) => number(&value, "p").map(|price| MarketEvent::OptionTrade {
                symbol,
                price,
                size: number(&value, "s").unwrap_or(0.0),
                timestamp,
            }),
            ("t", false) => number(&value, "p").map(|price| MarketEvent::StockTrade {
                symbol,
                price,
                size: number(&value, "s").unwrap_or(0.0),
                timestamp,
            }),
            _ => None,
        };
        if let Some(event) = event {
            let _ = tx.send(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stream_quote_maps_correctly() {
        let (tx, mut rx) = broadcast::channel(8);
        forward_events(
            br#"[{"T":"q","S":"QQQ","bp":600.1,"ap":600.2,"t":"2026-10-07T12:00:00Z"}]"#,
            false,
            false,
            &tx,
            "stocks",
        );
        match rx.try_recv().unwrap() {
            MarketEvent::StockQuote { symbol, bid, .. } => {
                assert_eq!(symbol, "QQQ");
                assert_eq!(bid, Some(600.1));
            }
            _ => panic!("wrong event"),
        }
    }
    #[test]
    fn msgpack_option_quote_decodes() {
        let (tx, mut rx) = broadcast::channel(8);
        let record = json!([{"T":"q","S":"QQQ261007P00600000","bp":1.2,"ap":1.3,"t":"2026-10-07T12:00:00Z"}]);
        let bytes = rmp_serde::to_vec(&record).unwrap();
        forward_events(&bytes, true, true, &tx, "options");
        assert!(matches!(
            rx.try_recv().unwrap(),
            MarketEvent::OptionQuote { .. }
        ));
    }
}
