//! Bounded browser projection for the Gateway's existing shared market stream.
//!
//! The Broker port owns provider decoding and subscription acknowledgements. This module only
//! projects those validated records into the existing OpenTerminal SSE contract. It deliberately
//! keeps source and entitlement unknown until an independent evidence owner is connected.
//! Feed status replay is bounded to two latest snapshots and shares the publication sequence lock.
//!
//! Gateway 只把 Broker 已校验的记录投影到现有 OpenTerminal SSE 合同，不重复解析 provider 协议。
//! 在独立证据 owner 接入前，行情来源和 entitlement 始终保持 unknown。
//! 状态回放最多保留两个 feed 快照，并与事件序号分配保持一致顺序。

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};

use broker_ports::MarketDataPort;
use eqo_domain::MarketEvent;
use market_contracts::{DecimalString, MarketEventEnvelopeV1, MarketEventV1};
use serde::Serialize;
use tokio::sync::{broadcast, watch};
use uuid::Uuid;

pub(crate) const OPTION_FEED_NAME: &str = "options";
pub(crate) const STOCK_FEED_NAME: &str = "stocks";
pub(crate) const OPRA_FEED: &str = "opra";
pub(crate) const UNKNOWN_SOURCE_MODE: &str = "unknown";
pub(crate) const UNKNOWN_SOURCE_LABEL: &str = "source unknown";
pub(crate) const UNKNOWN_ENTITLEMENT: &str = "unknown";

/// The adapter's 32 quote/trade channel entries allow at most 16 symbols when both channels are
/// requested for every option contract.
/// Native adapter 每个订阅最多接受 32 个 quote/trade channel 项；每个合约同时订阅两种 channel 时最多 16 个。
pub(crate) const MAX_BROKER_OPTION_SYMBOLS: usize = market_contracts::MAX_CONTROL_INSTRUMENTS / 2;

/// One desired Gateway-wide options lease union and its monotonic local revision.
/// Gateway 期权租约并集及其单调递增的本地修订号。
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct OptionSubscriptionRevision {
    pub revision: u64,
    pub symbols: Vec<String>,
}

/// Quote and trade subscription sets reported to the current browser store.
/// 发给现有浏览器 store 的 quote/trade 订阅集合。
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
pub(crate) struct ChannelSymbols {
    pub quotes: Vec<String>,
    pub trades: Vec<String>,
}

/// A redacted upstream failure category. Provider text is never forwarded to the browser.
/// 脱敏后的上游错误分类；不会把 provider 原文传给浏览器。
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct FeedError {
    pub code: Option<u16>,
    pub class: String,
}

/// Current Gateway observation for one feed, matching the existing OpenTerminal store shape.
/// 单个 feed 的 Gateway 当前观察状态，与现有 OpenTerminal store 结构一致。
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FeedStatusSnapshot {
    pub feed: String,
    pub transport: String,
    pub auth: String,
    pub desired: ChannelSymbols,
    pub confirmed: Option<ChannelSymbols>,
    pub pending_subscribe: ChannelSymbols,
    pub pending_unsubscribe: ChannelSymbols,
    pub upstream: String,
    pub coverage_limit: Option<usize>,
    pub coverage_complete: bool,
    pub connection_epoch: u64,
    pub last_error: Option<FeedError>,
    pub decode_error_count: u64,
    pub resync_required: bool,
}

/// JSON event union consumed by the existing OpenTerminal SSE provider and Zustand store.
/// 由现有 OpenTerminal SSE provider 与 Zustand store 消费的 JSON 行情事件联合类型。
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum GatewayMarketEvent {
    FeedStatus {
        source_mode: &'static str,
        source_label: &'static str,
        source_entitlement: &'static str,
        gateway_instance_id: String,
        feed: String,
        transport: String,
        auth: String,
        desired: ChannelSymbols,
        confirmed: Option<ChannelSymbols>,
        pending: PendingChannels,
        upstream: String,
        coverage: Coverage,
        coverage_complete: bool,
        connection_epoch: u64,
        local_sequence: u64,
        received_at: Option<String>,
        last_error: Option<FeedError>,
        decode_error_count: u64,
        resync_required: bool,
    },
    StockQuote {
        source_mode: &'static str,
        source_label: &'static str,
        source_entitlement: &'static str,
        gateway_instance_id: String,
        event_time: Option<String>,
        received_at: String,
        connection_epoch: u64,
        local_sequence: u64,
        symbol: String,
        bid: Option<f64>,
        ask: Option<f64>,
    },
    StockTrade {
        source_mode: &'static str,
        source_label: &'static str,
        source_entitlement: &'static str,
        gateway_instance_id: String,
        event_time: Option<String>,
        received_at: String,
        connection_epoch: u64,
        local_sequence: u64,
        symbol: String,
        price: f64,
        size: f64,
    },
    OptionQuote {
        source_mode: &'static str,
        source_label: &'static str,
        source_entitlement: &'static str,
        gateway_instance_id: String,
        event_time: Option<String>,
        received_at: String,
        connection_epoch: u64,
        local_sequence: u64,
        symbol: String,
        bid: Option<f64>,
        ask: Option<f64>,
        bid_size: Option<f64>,
        ask_size: Option<f64>,
    },
    OptionTrade {
        source_mode: &'static str,
        source_label: &'static str,
        source_entitlement: &'static str,
        gateway_instance_id: String,
        event_time: Option<String>,
        received_at: String,
        connection_epoch: u64,
        local_sequence: u64,
        symbol: String,
        price: f64,
        size: f64,
    },
}

impl GatewayMarketEvent {
    /// Return the Gateway-local publication sequence used to order browser events.
    /// 返回 Gateway 本地发布序号，用于排序浏览器事件。
    pub(crate) fn local_sequence(&self) -> u64 {
        match self {
            Self::FeedStatus { local_sequence, .. }
            | Self::StockQuote { local_sequence, .. }
            | Self::StockTrade { local_sequence, .. }
            | Self::OptionQuote { local_sequence, .. }
            | Self::OptionTrade { local_sequence, .. } => *local_sequence,
        }
    }
}

/// Pending subscribe/unsubscribe projections used by the existing market widgets.
/// 现有行情 widget 使用的待订阅与待退订投影。
#[derive(Clone, Debug, Serialize)]
pub(crate) struct PendingChannels {
    pub subscribe: ChannelSymbols,
    pub unsubscribe: ChannelSymbols,
}

/// Coverage fields consumed by the existing feed-status component.
/// 现有 feed-status 组件消费的覆盖率字段。
#[derive(Clone, Debug, Serialize)]
pub(crate) struct Coverage {
    pub desired_count: usize,
    pub confirmed_count: usize,
    pub limit: Option<usize>,
    pub complete: bool,
}

/// Publisher for the one Gateway broadcast consumed by SSE and the existing WebSocket route.
/// SSE 与既有 WebSocket 共用的 Gateway 行情广播发布器。
#[derive(Clone)]
pub(crate) struct MarketPublisher {
    tx: broadcast::Sender<GatewayMarketEvent>,
    gateway_instance_id: Arc<str>,
    sequence: Arc<AtomicU64>,
    publication_order: Arc<Mutex<()>>,
    latest_status: Arc<Mutex<LatestFeedStatus>>,
}

/// Bounded replay state for the only Gateway feeds exposed by this publisher.
/// 仅保留此发布器公开的两个 feed 的有界状态快照。
#[derive(Default)]
struct LatestFeedStatus {
    stocks: Option<FeedStatusSnapshot>,
    options: Option<FeedStatusSnapshot>,
}

fn disconnected_feed_status(feed: &str) -> FeedStatusSnapshot {
    FeedStatusSnapshot {
        feed: feed.to_owned(),
        transport: "disconnected".to_owned(),
        auth: "unknown".to_owned(),
        desired: ChannelSymbols::default(),
        confirmed: None,
        pending_subscribe: ChannelSymbols::default(),
        pending_unsubscribe: ChannelSymbols::default(),
        upstream: "degraded".to_owned(),
        coverage_limit: None,
        coverage_complete: false,
        connection_epoch: 0,
        last_error: None,
        decode_error_count: 0,
        resync_required: true,
    }
}

impl MarketPublisher {
    pub(crate) fn new(tx: broadcast::Sender<GatewayMarketEvent>) -> Self {
        Self {
            tx,
            gateway_instance_id: Arc::from(Uuid::new_v4().to_string()),
            sequence: Arc::new(AtomicU64::new(0)),
            publication_order: Arc::new(Mutex::new(())),
            latest_status: Arc::new(Mutex::new(LatestFeedStatus::default())),
        }
    }

    #[cfg(test)]
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<GatewayMarketEvent> {
        self.tx.subscribe()
    }

    /// Subscribe atomically with a bounded replay of the most recent feed states.
    /// 原子建立订阅并回放最近的 feed 状态，避免错过订阅确认广播。
    pub(crate) fn subscribe_with_snapshot(
        &self,
    ) -> (
        broadcast::Receiver<GatewayMarketEvent>,
        Vec<GatewayMarketEvent>,
    ) {
        let _publication = self
            .publication_order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let latest = self
            .latest_status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let receiver = self.tx.subscribe();
        let snapshot = [latest.stocks.as_ref(), latest.options.as_ref()]
            .into_iter()
            .flatten()
            .filter_map(|status| {
                let mut status = status.clone();
                status.resync_required = true;
                self.status_event(status)
            })
            .collect();
        (receiver, snapshot)
    }

    pub(crate) fn gateway_instance_id(&self) -> &str {
        &self.gateway_instance_id
    }

    pub(crate) fn publish_status(&self, snapshot: FeedStatusSnapshot) {
        if !matches!(snapshot.feed.as_str(), STOCK_FEED_NAME | OPTION_FEED_NAME) {
            return;
        }
        let _publication = self
            .publication_order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut latest = self
            .latest_status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous_epoch = match snapshot.feed.as_str() {
            STOCK_FEED_NAME => latest.stocks.as_ref().map(|status| status.connection_epoch),
            OPTION_FEED_NAME => latest
                .options
                .as_ref()
                .map(|status| status.connection_epoch),
            _ => None,
        };
        if previous_epoch.is_some_and(|epoch| snapshot.connection_epoch < epoch) {
            return;
        }
        let Some(event) = self.status_event(snapshot.clone()) else {
            return;
        };
        match snapshot.feed.as_str() {
            STOCK_FEED_NAME => latest.stocks = Some(snapshot),
            OPTION_FEED_NAME => latest.options = Some(snapshot),
            _ => unreachable!("feed was checked before publication"),
        }
        let _ = self.tx.send(event);
    }

    pub(crate) fn resync_event(&self, feed: &str) -> Option<GatewayMarketEvent> {
        if !matches!(feed, STOCK_FEED_NAME | OPTION_FEED_NAME) {
            return None;
        }
        let _publication = self
            .publication_order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let latest = self
            .latest_status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.resync_event_from_latest(feed, &latest)
    }

    /// Build both feed snapshots under one publication lock with strictly increasing sequences.
    /// 在同一发布锁内为两个 feed 构造快照，保证序号严格递增。
    pub(crate) fn resync_events(&self) -> Vec<GatewayMarketEvent> {
        let _publication = self
            .publication_order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let latest = self
            .latest_status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        [STOCK_FEED_NAME, OPTION_FEED_NAME]
            .into_iter()
            .filter_map(|feed| self.resync_event_from_latest(feed, &latest))
            .collect()
    }

    fn resync_event_from_latest(
        &self,
        feed: &str,
        latest: &LatestFeedStatus,
    ) -> Option<GatewayMarketEvent> {
        let mut snapshot = match feed {
            STOCK_FEED_NAME => latest.stocks.clone(),
            OPTION_FEED_NAME => latest.options.clone(),
            _ => return None,
        }
        .unwrap_or_else(|| disconnected_feed_status(feed));
        snapshot.resync_required = true;
        self.status_event(snapshot)
    }

    fn status_event(&self, snapshot: FeedStatusSnapshot) -> Option<GatewayMarketEvent> {
        let Some(local_sequence) = self.next_sequence() else {
            return None;
        };
        let desired_count = snapshot
            .desired
            .quotes
            .len()
            .max(snapshot.desired.trades.len());
        let confirmed_count = snapshot.confirmed.as_ref().map_or(0, |confirmed| {
            confirmed.quotes.len().min(confirmed.trades.len())
        });
        let event = GatewayMarketEvent::FeedStatus {
            source_mode: UNKNOWN_SOURCE_MODE,
            source_label: UNKNOWN_SOURCE_LABEL,
            source_entitlement: UNKNOWN_ENTITLEMENT,
            gateway_instance_id: self.gateway_instance_id.to_string(),
            feed: snapshot.feed,
            transport: snapshot.transport,
            auth: snapshot.auth,
            desired: snapshot.desired,
            confirmed: snapshot.confirmed,
            pending: PendingChannels {
                subscribe: snapshot.pending_subscribe,
                unsubscribe: snapshot.pending_unsubscribe,
            },
            upstream: snapshot.upstream,
            coverage: Coverage {
                desired_count,
                confirmed_count,
                limit: snapshot.coverage_limit,
                complete: snapshot.coverage_complete,
            },
            coverage_complete: snapshot.coverage_complete,
            connection_epoch: snapshot.connection_epoch,
            local_sequence,
            received_at: Some(now_rfc3339()),
            last_error: snapshot.last_error,
            decode_error_count: snapshot.decode_error_count,
            resync_required: snapshot.resync_required,
        };
        Some(event)
    }

    pub(crate) fn publish_option_envelope(
        &self,
        envelope: &MarketEventEnvelopeV1,
        connection_epoch: u64,
    ) -> bool {
        if envelope.validate().is_err()
            || envelope.metadata.source.provider != "alpaca"
            || envelope.metadata.source.feed != OPRA_FEED
        {
            return false;
        }
        let received_at = envelope.metadata.received_timestamp.as_str().to_owned();
        let event_time = envelope
            .metadata
            .source_timestamp
            .as_ref()
            .map(|timestamp| timestamp.as_str().to_owned());
        let _publication = self
            .publication_order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let source = SourceProjection::unknown();
        let base = EventBase {
            source,
            gateway_instance_id: self.gateway_instance_id.to_string(),
            event_time,
            received_at,
            connection_epoch,
            local_sequence: match self.next_sequence() {
                Some(sequence) => sequence,
                None => return false,
            },
        };
        let event = match &envelope.event {
            MarketEventV1::OptionQuote {
                symbol,
                bid,
                ask,
                bid_size,
                ask_size,
            } => {
                let Some(bid) = decimal_projection(bid.as_ref()) else {
                    return false;
                };
                let Some(ask) = decimal_projection(ask.as_ref()) else {
                    return false;
                };
                let Some(bid_size) = decimal_projection(bid_size.as_ref()) else {
                    return false;
                };
                let Some(ask_size) = decimal_projection(ask_size.as_ref()) else {
                    return false;
                };
                GatewayMarketEvent::OptionQuote {
                    source_mode: base.source.mode,
                    source_label: base.source.label,
                    source_entitlement: base.source.entitlement,
                    gateway_instance_id: base.gateway_instance_id,
                    event_time: base.event_time,
                    received_at: base.received_at,
                    connection_epoch: base.connection_epoch,
                    local_sequence: base.local_sequence,
                    symbol: symbol.clone(),
                    bid,
                    ask,
                    bid_size,
                    ask_size,
                }
            }
            MarketEventV1::OptionTrade {
                symbol,
                price,
                size,
            } => {
                let Some(price) = required_decimal_projection(price.as_str()) else {
                    return false;
                };
                let Some(size) = required_decimal_projection(size.as_str()) else {
                    return false;
                };
                GatewayMarketEvent::OptionTrade {
                    source_mode: base.source.mode,
                    source_label: base.source.label,
                    source_entitlement: base.source.entitlement,
                    gateway_instance_id: base.gateway_instance_id,
                    event_time: base.event_time,
                    received_at: base.received_at,
                    connection_epoch: base.connection_epoch,
                    local_sequence: base.local_sequence,
                    symbol: symbol.clone(),
                    price,
                    size,
                }
            }
            MarketEventV1::StockQuote { .. } | MarketEventV1::StockTrade { .. } => return false,
        };
        self.tx.send(event).is_ok()
    }

    pub(crate) fn publish_legacy_stock_event(
        &self,
        event: MarketEvent,
        connection_epoch: u64,
    ) -> bool {
        let now = now_rfc3339();
        let source = SourceProjection::unknown();
        let (event, received_at, event_time) = match event {
            MarketEvent::StockQuote {
                symbol, bid, ask, ..
            } => (LegacyData::StockQuote { symbol, bid, ask }, now, None),
            MarketEvent::StockTrade {
                symbol,
                price,
                size,
                ..
            } => (
                LegacyData::StockTrade {
                    symbol,
                    price,
                    size,
                },
                now,
                None,
            ),
            MarketEvent::OptionQuote { .. }
            | MarketEvent::OptionTrade { .. }
            | MarketEvent::FeedStatus { .. } => return false,
        };
        let _publication = self
            .publication_order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let base = EventBase {
            source,
            gateway_instance_id: self.gateway_instance_id.to_string(),
            event_time,
            received_at,
            connection_epoch,
            local_sequence: match self.next_sequence() {
                Some(sequence) => sequence,
                None => return false,
            },
        };
        let event = match event {
            LegacyData::StockQuote { symbol, bid, ask } => GatewayMarketEvent::StockQuote {
                source_mode: base.source.mode,
                source_label: base.source.label,
                source_entitlement: base.source.entitlement,
                gateway_instance_id: base.gateway_instance_id,
                event_time: base.event_time,
                received_at: base.received_at,
                connection_epoch: base.connection_epoch,
                local_sequence: base.local_sequence,
                symbol,
                bid,
                ask,
            },
            LegacyData::StockTrade {
                symbol,
                price,
                size,
            } => GatewayMarketEvent::StockTrade {
                source_mode: base.source.mode,
                source_label: base.source.label,
                source_entitlement: base.source.entitlement,
                gateway_instance_id: base.gateway_instance_id,
                event_time: base.event_time,
                received_at: base.received_at,
                connection_epoch: base.connection_epoch,
                local_sequence: base.local_sequence,
                symbol,
                price,
                size,
            },
        };
        self.tx.send(event).is_ok()
    }

    fn next_sequence(&self) -> Option<u64> {
        self.sequence
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .ok()
            .and_then(|previous| previous.checked_add(1))
    }
}

/// Projects the legacy stock stream into the existing rich browser event contract.
/// 将旧股票流投影到现有丰富浏览器事件合同。
pub(crate) async fn bridge_legacy_stock_stream(
    mut source: broadcast::Receiver<MarketEvent>,
    mut desired_rx: watch::Receiver<Vec<String>>,
    publisher: MarketPublisher,
    limit: usize,
) {
    let mut desired = desired_rx.borrow_and_update().clone();
    let mut connection_epoch = 0_u64;
    let mut transport = "disconnected";
    let mut last_error = None;
    publisher.publish_status(legacy_stock_status(
        &desired,
        limit,
        connection_epoch,
        transport,
        last_error.clone(),
        false,
    ));

    loop {
        tokio::select! {
            changed = desired_rx.changed() => {
                if changed.is_err() {
                    return;
                }
                desired = desired_rx.borrow_and_update().clone();
                publisher.publish_status(legacy_stock_status(
                    &desired, limit, connection_epoch, transport, last_error.clone(), false,
                ));
            }
            received = source.recv() => match received {
                Ok(MarketEvent::FeedStatus { state, .. }) => {
                    match state.as_str() {
                        "connecting" => {
                            connection_epoch = connection_epoch.checked_add(1).unwrap_or(u64::MAX);
                            transport = "connecting";
                            last_error = None;
                        }
                        "connected" => {
                            transport = "connected";
                            last_error = None;
                        }
                        "disconnected" => {
                            transport = "disconnected";
                            last_error = Some(FeedError { code: None, class: "upstream_disconnected".into() });
                        }
                        value if value.starts_with("error:") => {
                            last_error = Some(FeedError { code: None, class: "upstream_error".into() });
                        }
                        _ => {
                            last_error = Some(FeedError { code: None, class: "upstream_status_unknown".into() });
                        }
                    }
                    publisher.publish_status(legacy_stock_status(
                        &desired, limit, connection_epoch, transport, last_error.clone(), false,
                    ));
                }
                Ok(event) => {
                    let _ = publisher.publish_legacy_stock_event(event, connection_epoch);
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    publisher.publish_status(legacy_stock_status(
                        &desired, limit, connection_epoch, transport, last_error.clone(), true,
                    ));
                }
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }
}

fn legacy_stock_status(
    symbols: &[String],
    limit: usize,
    connection_epoch: u64,
    transport: &str,
    last_error: Option<FeedError>,
    resync_required: bool,
) -> FeedStatusSnapshot {
    let desired = ChannelSymbols {
        quotes: symbols.to_vec(),
        trades: symbols.to_vec(),
    };
    FeedStatusSnapshot {
        feed: STOCK_FEED_NAME.to_owned(),
        transport: transport.to_owned(),
        auth: "unknown".to_owned(),
        pending_subscribe: desired.clone(),
        desired,
        confirmed: None,
        pending_unsubscribe: ChannelSymbols::default(),
        upstream: "degraded".to_owned(),
        coverage_limit: Some(limit),
        coverage_complete: false,
        connection_epoch,
        last_error,
        decode_error_count: 0,
        resync_required,
    }
}

struct SourceProjection {
    mode: &'static str,
    label: &'static str,
    entitlement: &'static str,
}

impl SourceProjection {
    fn unknown() -> Self {
        Self {
            mode: UNKNOWN_SOURCE_MODE,
            label: UNKNOWN_SOURCE_LABEL,
            entitlement: UNKNOWN_ENTITLEMENT,
        }
    }
}

struct EventBase {
    source: SourceProjection,
    gateway_instance_id: String,
    event_time: Option<String>,
    received_at: String,
    connection_epoch: u64,
    local_sequence: u64,
}

enum LegacyData {
    StockQuote {
        symbol: String,
        bid: Option<f64>,
        ask: Option<f64>,
    },
    StockTrade {
        symbol: String,
        price: f64,
        size: f64,
    },
}

fn decimal_projection(value: Option<&DecimalString>) -> Option<Option<f64>> {
    match value {
        None => Some(None),
        Some(decimal) => required_decimal_projection(decimal.as_str()).map(Some),
    }
}

fn required_decimal_projection(value: &str) -> Option<f64> {
    value.parse::<f64>().ok().filter(|value| value.is_finite())
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)
}

#[cfg(test)]
mod tests;
