//! Single-session options lease consumer backed by the Broker read-only port.
//!
//! Gateway owns the browser lease union; Broker owns provider decoding, reconnect state and the
//! actual subscription ACK. A changed union cancels and drains the old bounded lane before a new
//! port session can start. A drain timeout poisons this supervisor instead of risking overlap.
//!
//! Gateway 负责浏览器租约并集；Broker 负责 provider 解码、重连状态和订阅 ACK。租约变化时先取消并排空
//! 旧有界队列，再启动新会话；排空超时会永久关闭本 supervisor，避免上游连接重叠。

use std::{future::Future, sync::Arc, time::Duration};

use alpaca_stream::{
    AlpacaCredentials, AlpacaOptionsMarketDataPort, CredentialFailure, CredentialProvider,
    StreamEnvironment,
};
use broker_ports::{
    BrokerPortError, MarketDataItem, MarketDataPort, MarketDataSession,
    MarketDataSubscriptionRequest, RawFrameDisposition,
};
use market_contracts::{
    ConnectionState, ControlEventEnvelopeV1, EntitlementState, MarketControlEventV1,
};
use tokio::sync::watch;
use tokio::time::timeout;

use crate::market_stream::{
    ChannelSymbols, FeedError, FeedStatusSnapshot, MarketPublisher, OptionSubscriptionRevision,
    OPRA_FEED, OPTION_FEED_NAME,
};

const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// Creates the fixed-origin, read-only Alpaca OPRA adapter without reading credentials eagerly.
/// 创建固定来源、只读的 Alpaca OPRA adapter；不会提前读取凭证。
pub(crate) fn alpaca_opra_port() -> Arc<dyn MarketDataPort> {
    Arc::new(AlpacaOptionsMarketDataPort::new(
        StreamEnvironment::Production,
        GatewayEnvironmentCredentials,
    ))
}

struct GatewayEnvironmentCredentials;

impl CredentialProvider for GatewayEnvironmentCredentials {
    fn load_credentials(
        &mut self,
    ) -> impl Future<Output = Result<AlpacaCredentials, CredentialFailure>> + Send {
        async {
            let key = std::env::var("ALPACA_KEY").map_err(|_| CredentialFailure::Unavailable)?;
            let secret =
                std::env::var("ALPACA_SECRET").map_err(|_| CredentialFailure::Unavailable)?;
            AlpacaCredentials::new(key, secret).map_err(|_| CredentialFailure::Unavailable)
        }
    }
}

/// Runs the sole Gateway OPRA session and publishes its ACK-driven status to the shared SSE bus.
/// 运行 Gateway 唯一 OPRA 会话，并把由 ACK 驱动的状态发布到共享 SSE 广播。
pub(crate) async fn run_option_market_stream(
    port: Option<Arc<dyn MarketDataPort>>,
    revisions: watch::Receiver<OptionSubscriptionRevision>,
    publisher: MarketPublisher,
    limit: usize,
) {
    run_option_market_stream_with_drain_timeout(port, revisions, publisher, limit, DRAIN_TIMEOUT)
        .await;
}

async fn run_option_market_stream_with_drain_timeout(
    port: Option<Arc<dyn MarketDataPort>>,
    mut revisions: watch::Receiver<OptionSubscriptionRevision>,
    publisher: MarketPublisher,
    limit: usize,
    drain_timeout: Duration,
) {
    let mut state = OptionRuntime::new(limit);
    let mut current = revisions.borrow_and_update().clone();
    state.set_desired(&current, false);
    publisher.publish_status(state.snapshot());

    loop {
        if current.symbols.is_empty() {
            state.idle(&current);
            publisher.publish_status(state.snapshot());
            let Some(next) = wait_for_revision(&mut revisions, &current).await else {
                return;
            };
            current = next;
            continue;
        }

        let Some(port) = port.as_ref() else {
            state.unavailable(&current, "options_source_not_configured");
            publisher.publish_status(state.snapshot());
            let Some(next) = wait_for_revision(&mut revisions, &current).await else {
                return;
            };
            current = next;
            continue;
        };

        if current.symbols.len() > limit {
            state.unavailable(&current, "subscription_limit_exceeded");
            publisher.publish_status(state.snapshot());
            let Some(next) = wait_for_revision(&mut revisions, &current).await else {
                return;
            };
            current = next;
            continue;
        }

        state.begin_subscription(&current);
        publisher.publish_status(state.snapshot());
        let request = match MarketDataSubscriptionRequest::new(
            "alpaca",
            OPRA_FEED,
            current.symbols.clone(),
            current.symbols.clone(),
        ) {
            Ok(request) => request,
            Err(error) => {
                state.port_failure(&current, error);
                publisher.publish_status(state.snapshot());
                let Some(next) = wait_for_revision(&mut revisions, &current).await else {
                    return;
                };
                current = next;
                continue;
            }
        };

        let mut session = match port.subscribe(request).await {
            Ok(session) => session,
            Err(error) => {
                state.port_failure(&current, error);
                publisher.publish_status(state.snapshot());
                let Some(next) = wait_for_revision(&mut revisions, &current).await else {
                    return;
                };
                current = next;
                continue;
            }
        };

        match consume_session(
            &mut session,
            &mut revisions,
            &current,
            &mut state,
            &publisher,
        )
        .await
        {
            SessionEnd::RevisionChanged(next) => {
                state.set_desired(&next, true);
                publisher.publish_status(state.snapshot());
                let drained = cancel_and_drain(&mut session, drain_timeout).await;
                if !drained {
                    state.poisoned(&next);
                    publisher.publish_status(state.snapshot());
                    return;
                }
                state.drained();
                publisher.publish_status(state.snapshot());
                current = next;
            }
            SessionEnd::Closed => {
                state.closed();
                publisher.publish_status(state.snapshot());
                let Some(next) = wait_for_revision(&mut revisions, &current).await else {
                    return;
                };
                current = next;
            }
            SessionEnd::DesiredChannelClosed => return,
        }
    }
}

async fn cancel_and_drain(session: &mut MarketDataSession, drain_timeout: Duration) -> bool {
    session.cancel();
    timeout(drain_timeout, async {
        while session.records.recv().await.is_some() {}
    })
    .await
    .is_ok()
}

enum SessionEnd {
    RevisionChanged(OptionSubscriptionRevision),
    Closed,
    DesiredChannelClosed,
}

async fn consume_session(
    session: &mut MarketDataSession,
    revisions: &mut watch::Receiver<OptionSubscriptionRevision>,
    current: &OptionSubscriptionRevision,
    state: &mut OptionRuntime,
    publisher: &MarketPublisher,
) -> SessionEnd {
    loop {
        tokio::select! {
            biased;
            changed = revisions.changed() => {
                if changed.is_err() {
                    return SessionEnd::DesiredChannelClosed;
                }
                let next = revisions.borrow_and_update().clone();
                if next != *current {
                    return SessionEnd::RevisionChanged(next);
                }
            }
            record = session.records.recv() => match record {
                Some(record) => {
                    if state.consume(record, publisher) {
                        publisher.publish_status(state.snapshot());
                    }
                }
                None => return SessionEnd::Closed,
            }
        }
    }
}

async fn wait_for_revision(
    revisions: &mut watch::Receiver<OptionSubscriptionRevision>,
    current: &OptionSubscriptionRevision,
) -> Option<OptionSubscriptionRevision> {
    loop {
        if revisions.changed().await.is_err() {
            return None;
        }
        let next = revisions.borrow_and_update().clone();
        if next != *current {
            return Some(next);
        }
    }
}

struct OptionRuntime {
    desired: Vec<String>,
    confirmed: Option<Vec<String>>,
    pending_unsubscribe: Vec<String>,
    transport: &'static str,
    upstream: &'static str,
    coverage_complete: bool,
    connection_epoch: u64,
    broker_generation: Option<u64>,
    last_broker_sequence: u64,
    last_error: Option<FeedError>,
    decode_error_count: u64,
    limit: usize,
}

impl OptionRuntime {
    fn new(limit: usize) -> Self {
        Self {
            desired: Vec::new(),
            confirmed: None,
            pending_unsubscribe: Vec::new(),
            transport: "disconnected",
            upstream: "degraded",
            coverage_complete: false,
            connection_epoch: 0,
            broker_generation: None,
            last_broker_sequence: 0,
            last_error: None,
            decode_error_count: 0,
            limit,
        }
    }

    fn set_desired(&mut self, revision: &OptionSubscriptionRevision, retain_unsubscribe: bool) {
        let previous = self.confirmed.take().unwrap_or_default();
        self.desired.clone_from(&revision.symbols);
        self.pending_unsubscribe = if retain_unsubscribe {
            previous
        } else {
            Vec::new()
        };
        self.transport = if self.desired.is_empty() {
            "disconnected"
        } else {
            "connecting"
        };
        self.upstream = "connecting";
        self.coverage_complete = false;
        self.last_error = None;
    }

    fn begin_subscription(&mut self, revision: &OptionSubscriptionRevision) {
        self.set_desired(revision, true);
        self.pending_unsubscribe.clear();
        self.transport = "connecting";
        self.upstream = "connecting";
    }

    fn idle(&mut self, revision: &OptionSubscriptionRevision) {
        self.set_desired(revision, false);
        self.pending_unsubscribe.clear();
        self.transport = "disconnected";
        self.upstream = "degraded";
        self.last_error = None;
    }

    fn unavailable(&mut self, revision: &OptionSubscriptionRevision, class: &str) {
        self.set_desired(revision, false);
        self.transport = "disconnected";
        self.upstream = "degraded";
        self.last_error = Some(fixed_error(class));
    }

    fn port_failure(&mut self, revision: &OptionSubscriptionRevision, error: BrokerPortError) {
        let class = match error {
            BrokerPortError::InvalidRequest => "subscription_request_invalid",
            BrokerPortError::LimitExceeded => "subscription_limit_exceeded",
            BrokerPortError::UnsupportedSource => "options_source_unsupported",
            BrokerPortError::Transport => "upstream_transport_failed",
            BrokerPortError::ProviderRejected => "upstream_rejected",
            BrokerPortError::Overloaded => "upstream_overloaded",
            BrokerPortError::ProtocolViolation => "upstream_protocol_violation",
        };
        self.unavailable(revision, class);
    }

    fn drained(&mut self) {
        self.pending_unsubscribe.clear();
        self.transport = "disconnected";
        self.upstream = "connecting";
    }

    fn closed(&mut self) {
        self.confirmed = None;
        self.transport = "disconnected";
        self.upstream = "degraded";
        self.coverage_complete = false;
        self.pending_unsubscribe.clear();
        if self.last_error.is_none() {
            self.last_error = Some(fixed_error("upstream_session_closed"));
        }
    }

    fn poisoned(&mut self, revision: &OptionSubscriptionRevision) {
        self.set_desired(revision, false);
        self.transport = "disconnected";
        self.upstream = "degraded";
        self.last_error = Some(fixed_error("session_drain_timeout"));
    }

    fn consume(&mut self, item: MarketDataItem, publisher: &MarketPublisher) -> bool {
        match item {
            MarketDataItem::Event { envelope, .. } => {
                let metadata = &envelope.metadata;
                if !self.observe_order(
                    metadata.source.provider.as_str(),
                    metadata.source.feed.as_str(),
                    metadata.generation,
                    metadata.sequence,
                ) {
                    return false;
                }
                if self.confirmed.is_none() {
                    return false;
                }
                if publisher.publish_option_envelope(&envelope, self.connection_epoch) {
                    false
                } else {
                    self.decode_error_count = self.decode_error_count.saturating_add(1);
                    self.coverage_complete = false;
                    self.upstream = "degraded";
                    self.last_error = Some(fixed_error("market_event_projection_failed"));
                    true
                }
            }
            MarketDataItem::Control(envelope) => self.consume_control(envelope),
            MarketDataItem::RawFrame(frame) => {
                if !self.observe_generation(
                    frame.provider.as_str(),
                    frame.feed.as_str(),
                    frame.generation,
                ) {
                    return false;
                }
                match frame.disposition {
                    RawFrameDisposition::UnknownMessage => {
                        self.record_diagnostic("unknown_provider_message")
                    }
                    RawFrameDisposition::ProviderError => {
                        self.record_diagnostic("provider_error_frame")
                    }
                    RawFrameDisposition::DecodeFailure => {
                        self.record_diagnostic("provider_decode_failure")
                    }
                    RawFrameDisposition::DecodedMarketData
                    | RawFrameDisposition::ControlMessage => false,
                }
            }
        }
    }

    fn consume_control(&mut self, envelope: ControlEventEnvelopeV1) -> bool {
        let metadata = &envelope.metadata;
        if envelope.validate().is_err()
            || !self.observe_order(
                metadata.source.provider.as_str(),
                metadata.source.feed.as_str(),
                metadata.generation,
                metadata.sequence,
            )
        {
            return false;
        }
        if metadata.source.entitlement != EntitlementState::Unknown {
            return false;
        }
        match envelope.control {
            MarketControlEventV1::ConnectionStatus { state } => {
                match state {
                    ConnectionState::Connecting => {
                        self.transport = "connecting";
                        self.upstream = "connecting";
                        self.confirmed = None;
                        self.coverage_complete = false;
                        self.last_error = None;
                    }
                    ConnectionState::Connected => {
                        self.transport = "connected";
                        self.upstream = if self.confirmed.is_some() {
                            "ready"
                        } else {
                            "connecting"
                        };
                    }
                    ConnectionState::Disconnected => {
                        self.fail_session("upstream_disconnected");
                    }
                    ConnectionState::Failed => {
                        self.fail_session("upstream_failed");
                    }
                }
                true
            }
            MarketControlEventV1::SubscriptionAck {
                acknowledged,
                rejected,
                ..
            } => {
                let mut acknowledged = acknowledged;
                acknowledged.sort();
                if rejected.is_empty() && acknowledged == self.desired {
                    self.confirmed = Some(self.desired.clone());
                    self.pending_unsubscribe.clear();
                    self.upstream = "ready";
                    self.coverage_complete = true;
                    self.transport = "connected";
                    self.last_error = None;
                } else {
                    self.confirmed = None;
                    self.upstream = "degraded";
                    self.coverage_complete = false;
                    self.last_error = Some(fixed_error("subscription_ack_incomplete"));
                }
                true
            }
            MarketControlEventV1::SubscriptionRejected { .. } => {
                self.confirmed = None;
                self.upstream = "degraded";
                self.coverage_complete = false;
                self.last_error = Some(fixed_error("subscription_rejected"));
                true
            }
        }
    }

    fn observe_order(
        &mut self,
        provider: &str,
        feed: &str,
        generation: u64,
        sequence: u64,
    ) -> bool {
        if !self.observe_generation(provider, feed, generation) {
            return false;
        }
        if sequence == 0 || sequence <= self.last_broker_sequence {
            return false;
        }
        self.last_broker_sequence = sequence;
        true
    }

    fn observe_generation(&mut self, provider: &str, feed: &str, generation: u64) -> bool {
        if provider != "alpaca" || feed != OPRA_FEED || generation == 0 {
            return false;
        }
        match self.broker_generation {
            Some(current) if generation < current => false,
            Some(current) if generation == current => true,
            _ => {
                let Some(next_epoch) = self.connection_epoch.checked_add(1) else {
                    self.fail_session("connection_epoch_exhausted");
                    return false;
                };
                self.connection_epoch = next_epoch;
                self.broker_generation = Some(generation);
                self.last_broker_sequence = 0;
                self.confirmed = None;
                self.coverage_complete = false;
                self.transport = "connecting";
                self.upstream = "connecting";
                self.last_error = None;
                true
            }
        }
    }

    fn record_diagnostic(&mut self, class: &str) -> bool {
        self.decode_error_count = self.decode_error_count.saturating_add(1);
        self.coverage_complete = false;
        self.upstream = "degraded";
        self.last_error = Some(fixed_error(class));
        true
    }

    fn fail_session(&mut self, class: &str) {
        self.confirmed = None;
        self.coverage_complete = false;
        self.transport = "disconnected";
        self.upstream = "degraded";
        self.last_error = Some(fixed_error(class));
    }

    fn snapshot(&self) -> FeedStatusSnapshot {
        let desired = channels(&self.desired);
        let confirmed = self.confirmed.as_deref().map(channels);
        let pending_subscribe = if self.confirmed.is_none() {
            desired.clone()
        } else {
            ChannelSymbols::default()
        };
        FeedStatusSnapshot {
            feed: OPTION_FEED_NAME.to_owned(),
            transport: self.transport.to_owned(),
            auth: "unknown".to_owned(),
            desired,
            confirmed,
            pending_subscribe,
            pending_unsubscribe: channels(&self.pending_unsubscribe),
            upstream: self.upstream.to_owned(),
            coverage_limit: Some(self.limit),
            coverage_complete: self.coverage_complete,
            connection_epoch: self.connection_epoch,
            last_error: self.last_error.clone(),
            decode_error_count: self.decode_error_count,
            resync_required: false,
        }
    }
}

fn fixed_error(class: &str) -> FeedError {
    FeedError {
        code: None,
        class: class.to_owned(),
    }
}

fn channels(symbols: &[String]) -> ChannelSymbols {
    ChannelSymbols {
        quotes: symbols.to_vec(),
        trades: symbols.to_vec(),
    }
}

#[cfg(test)]
#[path = "option_supervisor_tests.rs"]
mod tests;
