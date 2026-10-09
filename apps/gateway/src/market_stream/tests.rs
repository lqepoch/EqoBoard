use super::*;
use market_contracts::{
    DecimalString, EntitlementState, EventMetadataV1, MarketDataSourceV1, NumericEncodingV1,
    UtcTimestamp,
};

fn test_publisher() -> (MarketPublisher, broadcast::Receiver<GatewayMarketEvent>) {
    let (sender, _) = broadcast::channel(16);
    let publisher = MarketPublisher::new(sender);
    let receiver = publisher.subscribe();
    (publisher, receiver)
}

fn test_envelope() -> MarketEventEnvelopeV1 {
    MarketEventEnvelopeV1 {
        metadata: EventMetadataV1 {
            schema_version: 1,
            source: MarketDataSourceV1::new(
                "alpaca",
                "opra",
                EntitlementState::Unknown,
                NumericEncodingV1::DecimalToken,
                None,
            )
            .expect("test source is valid"),
            generation: 1,
            sequence: 3,
            raw_frame_sha256: None,
            source_timestamp: Some(
                UtcTimestamp::parse("2026-10-08T13:30:00.123456789Z")
                    .expect("source timestamp is valid"),
            ),
            received_timestamp: UtcTimestamp::parse("2026-10-08T13:30:00.223456789Z")
                .expect("receive timestamp is valid"),
        },
        event: MarketEventV1::OptionQuote {
            symbol: "QQQ261009C00600000".into(),
            bid: Some(DecimalString::new("1.20").expect("bid is valid")),
            ask: Some(DecimalString::new("1.25").expect("ask is valid")),
            bid_size: Some(DecimalString::new("2").expect("bid size is valid")),
            ask_size: Some(DecimalString::new("3").expect("ask size is valid")),
        },
    }
}

fn acknowledged_options_status(connection_epoch: u64) -> FeedStatusSnapshot {
    let symbols = vec!["QQQ261009C00600000".to_owned()];
    FeedStatusSnapshot {
        feed: OPTION_FEED_NAME.into(),
        transport: "connected".into(),
        auth: "unknown".into(),
        desired: ChannelSymbols {
            quotes: symbols.clone(),
            trades: symbols.clone(),
        },
        confirmed: Some(ChannelSymbols {
            quotes: symbols.clone(),
            trades: symbols,
        }),
        pending_subscribe: ChannelSymbols::default(),
        pending_unsubscribe: ChannelSymbols::default(),
        upstream: "ready".into(),
        coverage_limit: Some(MAX_BROKER_OPTION_SYMBOLS),
        coverage_complete: true,
        connection_epoch,
        last_error: None,
        decode_error_count: 0,
        resync_required: false,
    }
}

#[test]
fn option_projection_preserves_source_and_receive_times_but_stays_unknown() {
    let (publisher, mut receiver) = test_publisher();
    assert!(publisher.publish_option_envelope(&test_envelope(), 4));

    let event = serde_json::to_value(receiver.try_recv().expect("option event was published"))
        .expect("event serializes");
    assert_eq!(event["kind"], "option_quote");
    assert_eq!(event["symbol"], "QQQ261009C00600000");
    assert_eq!(event["bid"], 1.2);
    assert_eq!(event["event_time"], "2026-10-08T13:30:00.123456789Z");
    assert_eq!(event["received_at"], "2026-10-08T13:30:00.223456789Z");
    assert_eq!(event["connection_epoch"], 4);
    assert_eq!(event["source_mode"], UNKNOWN_SOURCE_MODE);
    assert_eq!(event["source_label"], UNKNOWN_SOURCE_LABEL);
    assert_eq!(event["source_entitlement"], UNKNOWN_ENTITLEMENT);
}

#[test]
fn feed_status_has_distinct_unknown_auth_entitlement_and_ack_fields() {
    let (publisher, mut receiver) = test_publisher();
    publisher.publish_status(FeedStatusSnapshot {
        feed: OPTION_FEED_NAME.into(),
        transport: "connected".into(),
        auth: "unknown".into(),
        desired: ChannelSymbols {
            quotes: vec!["QQQ261009C00600000".into()],
            trades: vec!["QQQ261009C00600000".into()],
        },
        confirmed: None,
        pending_subscribe: ChannelSymbols {
            quotes: vec!["QQQ261009C00600000".into()],
            trades: vec!["QQQ261009C00600000".into()],
        },
        pending_unsubscribe: ChannelSymbols::default(),
        upstream: "connecting".into(),
        coverage_limit: Some(MAX_BROKER_OPTION_SYMBOLS),
        coverage_complete: false,
        connection_epoch: 1,
        last_error: None,
        decode_error_count: 0,
        resync_required: false,
    });

    let event = serde_json::to_value(receiver.try_recv().expect("status was published"))
        .expect("status serializes");
    assert_eq!(event["kind"], "feed_status");
    assert_eq!(event["feed"], "options");
    assert_eq!(event["transport"], "connected");
    assert_eq!(event["auth"], "unknown");
    assert_eq!(event["confirmed"], serde_json::Value::Null);
    assert_eq!(event["coverage"]["complete"], false);
    assert_eq!(event["source_entitlement"], "unknown");
    assert_eq!(event["source_mode"], "unknown");
}

#[test]
fn resync_reuses_latest_feed_epoch_instead_of_resetting_to_zero() {
    let (publisher, _receiver) = test_publisher();
    publisher.publish_status(acknowledged_options_status(12));

    let event = serde_json::to_value(
        publisher
            .resync_event(OPTION_FEED_NAME)
            .expect("known feed gets a resync status"),
    )
    .expect("resync serializes");
    assert_eq!(event["kind"], "feed_status");
    assert_eq!(event["feed"], OPTION_FEED_NAME);
    assert_eq!(event["connection_epoch"], 12);
    assert_eq!(event["resync_required"], true);
    assert_eq!(event["confirmed"]["quotes"][0], "QQQ261009C00600000");
    assert_eq!(event["source_entitlement"], UNKNOWN_ENTITLEMENT);
}

#[test]
fn new_subscriber_receives_the_latest_ack_status_before_future_events() {
    let (publisher, _old_receiver) = test_publisher();
    publisher.publish_status(acknowledged_options_status(7));

    let (mut receiver, snapshot) = publisher.subscribe_with_snapshot();
    assert_eq!(snapshot.len(), 1);
    let replay = serde_json::to_value(&snapshot[0]).expect("snapshot serializes");
    assert_eq!(replay["feed"], OPTION_FEED_NAME);
    assert_eq!(replay["connection_epoch"], 7);
    assert_eq!(replay["confirmed"]["quotes"][0], "QQQ261009C00600000");
    assert_eq!(replay["coverage_complete"], true);
    assert_eq!(replay["resync_required"], true);

    assert!(publisher.publish_option_envelope(&test_envelope(), 8));
    let next = serde_json::to_value(
        receiver
            .try_recv()
            .expect("quote after replay is delivered"),
    )
    .expect("future status serializes");
    assert_eq!(next["kind"], "option_quote");
    assert_eq!(next["connection_epoch"], 8);
    assert!(next["local_sequence"].as_u64().unwrap() > replay["local_sequence"].as_u64().unwrap());
}

#[test]
fn status_replay_cache_is_limited_to_the_two_gateway_feeds() {
    let (publisher, _receiver) = test_publisher();
    let mut unknown = acknowledged_options_status(1);
    unknown.feed = "unregistered".into();
    publisher.publish_status(unknown);
    assert!(publisher.resync_event("unregistered").is_none());

    let (_receiver, snapshot) = publisher.subscribe_with_snapshot();
    assert!(snapshot.is_empty());
}
