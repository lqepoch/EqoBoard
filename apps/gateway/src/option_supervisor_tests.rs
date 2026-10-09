use super::*;
use broker_ports::PortFuture;
use market_contracts::{
    DecimalString, EventMetadataV1, MarketDataSourceV1, MarketEventEnvelopeV1, MarketEventV1,
    NumericEncodingV1, RejectedInstrumentV1, UtcTimestamp,
};
use std::sync::Mutex as StdMutex;
use tokio::sync::{broadcast, mpsc};

const SYMBOL: &str = "QQQ261009C00600000";

#[derive(Default)]
struct FakePort {
    senders: Arc<StdMutex<Vec<mpsc::Sender<MarketDataItem>>>>,
    requests: Arc<StdMutex<Vec<MarketDataSubscriptionRequest>>>,
}

impl FakePort {
    fn sender(&self) -> Option<mpsc::Sender<MarketDataItem>> {
        self.senders
            .lock()
            .expect("senders lock is healthy")
            .last()
            .cloned()
    }

    fn requests(&self) -> Vec<MarketDataSubscriptionRequest> {
        self.requests
            .lock()
            .expect("requests lock is healthy")
            .clone()
    }
}

impl MarketDataPort for FakePort {
    fn subscribe(
        &self,
        request: MarketDataSubscriptionRequest,
    ) -> PortFuture<'_, Result<MarketDataSession, BrokerPortError>> {
        let senders = Arc::clone(&self.senders);
        let requests = Arc::clone(&self.requests);
        Box::pin(async move {
            let (records_tx, records_rx) = mpsc::channel(16);
            senders
                .lock()
                .expect("senders lock is healthy")
                .push(records_tx);
            requests
                .lock()
                .expect("requests lock is healthy")
                .push(request);
            let (cancel_tx, mut cancel_rx) = watch::channel(false);
            let senders = Arc::clone(&senders);
            tokio::spawn(async move {
                if cancel_rx.changed().await.is_ok() && *cancel_rx.borrow() {
                    senders.lock().expect("senders lock is healthy").clear();
                }
            });
            Ok(MarketDataSession::new(records_rx, cancel_tx))
        })
    }
}

fn metadata(generation: u64, sequence: u64) -> EventMetadataV1 {
    EventMetadataV1 {
        schema_version: 1,
        source: MarketDataSourceV1::new(
            "alpaca",
            "opra",
            EntitlementState::Unknown,
            NumericEncodingV1::DecimalToken,
            None,
        )
        .expect("source metadata is valid"),
        generation,
        sequence,
        raw_frame_sha256: None,
        source_timestamp: Some(
            UtcTimestamp::parse("2026-10-08T13:30:00.123456789Z").expect("source time is valid"),
        ),
        received_timestamp: UtcTimestamp::parse("2026-10-08T13:30:00.223456789Z")
            .expect("receive time is valid"),
    }
}

fn control_item(sequence: u64, control: MarketControlEventV1) -> MarketDataItem {
    control_item_for(1, sequence, control)
}

fn control_item_for(
    generation: u64,
    sequence: u64,
    control: MarketControlEventV1,
) -> MarketDataItem {
    MarketDataItem::Control(ControlEventEnvelopeV1 {
        metadata: metadata(generation, sequence),
        control,
    })
}

fn exact_ack(sequence: u64) -> MarketDataItem {
    control_item(
        sequence,
        MarketControlEventV1::SubscriptionAck {
            request_id: "request-1".into(),
            subscription_id: "subscription-1".into(),
            acknowledged: vec![SYMBOL.into()],
            rejected: Vec::<RejectedInstrumentV1>::new(),
        },
    )
}

fn option_quote_item() -> MarketDataItem {
    MarketDataItem::Event {
        envelope: MarketEventEnvelopeV1 {
            metadata: metadata(1, 3),
            event: MarketEventV1::OptionQuote {
                symbol: SYMBOL.into(),
                bid: Some(DecimalString::new("1.20").expect("bid is valid")),
                ask: Some(DecimalString::new("1.25").expect("ask is valid")),
                bid_size: Some(DecimalString::new("2").expect("bid size is valid")),
                ask_size: Some(DecimalString::new("3").expect("ask size is valid")),
            },
        },
        raw_frame: None,
    }
}

async fn receive_until(
    receiver: &mut broadcast::Receiver<GatewayMarketEvent>,
    predicate: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let event = receiver
                .recv()
                .await
                .expect("gateway broadcast remains open");
            let value = serde_json::to_value(event).expect("gateway event serializes");
            if predicate(&value) {
                return value;
            }
        }
    })
    .await
    .expect("expected gateway event arrives before timeout")
}

#[tokio::test]
async fn fake_broker_ack_and_event_reach_the_gateway_stream_without_promoting_source() {
    let port = Arc::new(FakePort::default());
    let (bus, _) = broadcast::channel(64);
    let publisher = MarketPublisher::new(bus);
    let mut browser = publisher.subscribe();
    let initial = OptionSubscriptionRevision {
        revision: 1,
        symbols: vec![SYMBOL.into()],
    };
    let (desired_tx, desired_rx) = watch::channel(initial);
    let task = tokio::spawn(run_option_market_stream(
        Some(port.clone()),
        desired_rx,
        publisher,
        MAX_BROKER_OPTION_SYMBOLS,
    ));

    let request = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(request) = port.requests().first().cloned() {
                break request;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the fake broker receives a subscription request");
    assert_eq!(request.provider(), "alpaca");
    assert_eq!(request.feed(), "opra");
    assert_eq!(request.quote_symbols(), &[SYMBOL.to_owned()]);
    assert_eq!(request.trade_symbols(), &[SYMBOL.to_owned()]);

    let sender = port.sender().expect("fake session sender exists");
    sender
        .send(control_item(
            1,
            MarketControlEventV1::ConnectionStatus {
                state: ConnectionState::Connecting,
            },
        ))
        .await
        .expect("connecting control enters the bounded lane");
    sender
        .send(exact_ack(2))
        .await
        .expect("exact ACK enters the bounded lane");
    sender
        .send(option_quote_item())
        .await
        .expect("quote enters the bounded lane");
    drop(sender);

    let confirmed = receive_until(&mut browser, |value| {
        value["kind"] == "feed_status" && value["coverage"]["complete"] == true
    })
    .await;
    assert_eq!(confirmed["auth"], "unknown");
    assert_eq!(confirmed["source_entitlement"], "unknown");
    assert_eq!(confirmed["source_mode"], "unknown");
    assert_eq!(confirmed["confirmed"]["quotes"][0], SYMBOL);
    assert_eq!(confirmed["confirmed"]["trades"][0], SYMBOL);
    assert_eq!(confirmed["upstream"], "ready");

    let quote = receive_until(&mut browser, |value| value["kind"] == "option_quote").await;
    assert_eq!(quote["source_mode"], "unknown");
    assert_eq!(quote["source_entitlement"], "unknown");
    assert_eq!(quote["event_time"], "2026-10-08T13:30:00.123456789Z");
    assert_eq!(quote["received_at"], "2026-10-08T13:30:00.223456789Z");

    let replacement_symbol = "QQQ261009P00600000";
    desired_tx.send_replace(OptionSubscriptionRevision {
        revision: 2,
        symbols: vec![replacement_symbol.into()],
    });
    let replacement_request = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(request) = port.requests().get(1).cloned() {
                break request;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("new session starts after the previous bounded lane drains");
    assert_eq!(
        replacement_request.quote_symbols(),
        &[replacement_symbol.to_owned()]
    );
    assert_eq!(
        replacement_request.trade_symbols(),
        &[replacement_symbol.to_owned()]
    );

    desired_tx.send_replace(OptionSubscriptionRevision {
        revision: 3,
        symbols: Vec::new(),
    });
    let _ = receive_until(&mut browser, |value| {
        value["kind"] == "feed_status"
            && value["desired"]["quotes"]
                .as_array()
                .is_some_and(Vec::is_empty)
    })
    .await;
    task.abort();
}

#[tokio::test]
async fn drain_timeout_poison_stops_before_a_replacement_session() {
    let port = Arc::new(FakePort::default());
    let (bus, _) = broadcast::channel(64);
    let publisher = MarketPublisher::new(bus);
    let mut browser = publisher.subscribe();
    let (desired_tx, desired_rx) = watch::channel(OptionSubscriptionRevision {
        revision: 1,
        symbols: vec![SYMBOL.into()],
    });
    let task = tokio::spawn(run_option_market_stream_with_drain_timeout(
        Some(port.clone()),
        desired_rx,
        publisher,
        MAX_BROKER_OPTION_SYMBOLS,
        Duration::from_millis(25),
    ));

    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if !port.requests().is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("initial fake broker session starts");
    let keep_lane_open = port.sender().expect("fake session sender exists");

    desired_tx.send_replace(OptionSubscriptionRevision {
        revision: 2,
        symbols: vec!["QQQ261009P00600000".into()],
    });
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("poisoned supervisor exits without retrying")
        .expect("supervisor task completes");
    assert_eq!(port.requests().len(), 1);
    let poisoned = receive_until(&mut browser, |value| {
        value["kind"] == "feed_status" && value["last_error"]["class"] == "session_drain_timeout"
    })
    .await;
    assert_eq!(poisoned["confirmed"], serde_json::Value::Null);
    assert_eq!(poisoned["coverage"]["complete"], false);
    assert_eq!(poisoned["source_entitlement"], "unknown");
    drop(keep_lane_open);
}

#[test]
fn partial_ack_and_stale_broker_generation_cannot_confirm_current_symbols() {
    let mut state = OptionRuntime::new(MAX_BROKER_OPTION_SYMBOLS);
    let revision = OptionSubscriptionRevision {
        revision: 1,
        symbols: vec![SYMBOL.into()],
    };
    state.begin_subscription(&revision);

    let mut partial = control_item_for(
        2,
        1,
        MarketControlEventV1::SubscriptionAck {
            request_id: "request-1".into(),
            subscription_id: "subscription-1".into(),
            acknowledged: vec![SYMBOL.into()],
            rejected: Vec::new(),
        },
    );
    let MarketDataItem::Control(ref mut envelope) = partial else {
        panic!("ACK item is control");
    };
    let MarketControlEventV1::SubscriptionAck { acknowledged, .. } = &mut envelope.control else {
        panic!("expected subscription ACK");
    };
    *acknowledged = vec!["QQQ261009P00600000".into()];
    assert!(state.consume_control(match partial {
        MarketDataItem::Control(envelope) => envelope,
        _ => unreachable!(),
    }));
    assert!(state.confirmed.is_none());
    assert!(!state.coverage_complete);

    let current = match control_item_for(
        2,
        2,
        MarketControlEventV1::SubscriptionAck {
            request_id: "request-2".into(),
            subscription_id: "subscription-2".into(),
            acknowledged: vec![SYMBOL.into()],
            rejected: Vec::new(),
        },
    ) {
        MarketDataItem::Control(envelope) => envelope,
        _ => unreachable!(),
    };
    assert!(state.consume_control(current));
    assert_eq!(state.confirmed, Some(vec![SYMBOL.into()]));
    let stale = match control_item_for(
        1,
        99,
        MarketControlEventV1::SubscriptionAck {
            request_id: "stale-request".into(),
            subscription_id: "stale-subscription".into(),
            acknowledged: vec!["QQQ261009P00600000".into()],
            rejected: Vec::new(),
        },
    ) {
        MarketDataItem::Control(envelope) => envelope,
        _ => unreachable!(),
    };
    assert!(!state.consume_control(stale));
    assert_eq!(state.confirmed, Some(vec![SYMBOL.into()]));
}
