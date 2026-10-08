use eqo_domain::{parse_occ, MarketEvent, OccContract, Right};
use serde_json::json;

#[test]
fn legacy_market_event_json_shape_is_preserved() {
    let event = MarketEvent::StockQuote {
        symbol: "SPY".to_owned(),
        bid: Some(601.25),
        ask: None,
        timestamp: "2026-10-08T14:30:00Z".to_owned(),
    };

    assert_eq!(
        serde_json::to_value(event).unwrap(),
        json!({
            "kind": "stock_quote",
            "symbol": "SPY",
            "bid": 601.25,
            "ask": null,
            "timestamp": "2026-10-08T14:30:00Z"
        })
    );
}

#[test]
fn legacy_occ_json_and_parser_shape_are_preserved() {
    let contract = parse_occ("QQQ261016C00600000").unwrap();
    assert_eq!(
        serde_json::to_value(contract).unwrap(),
        json!({
            "underlying": "QQQ",
            "expiration": "2026-10-16",
            "right": "call",
            "strike": 600.0
        })
    );

    let decoded: OccContract = serde_json::from_value(json!({
        "underlying": "QQQ",
        "expiration": "2026-10-16",
        "right": "call",
        "strike": 600.0
    }))
    .unwrap();
    assert_eq!(decoded.underlying, "QQQ");
    assert_eq!(decoded.right, Right::Call);
}
