//! Read-only OpenBB row adapters. Market times remain tied to their source fields.
use eqo_alpaca_data::{BarsPage, ChainPage};
use eqo_domain::{Bar, OptionSnapshot, StockSnapshot};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Clone, Copy)]
struct MarketSource {
    source: &'static str,
    source_mode: &'static str,
    source_label: &'static str,
}

impl MarketSource {
    fn new(source_mode: &str, feed: &str) -> Self {
        match (source_mode, feed) {
            ("alpaca", "sip") => Self {
                source: "alpaca",
                source_mode: "alpaca",
                source_label: "Alpaca SIP",
            },
            ("alpaca", "opra") => Self {
                source: "alpaca",
                source_mode: "alpaca",
                source_label: "Alpaca OPRA",
            },
            _ => Self {
                source: "unknown",
                source_mode: "unknown",
                source_label: "source unknown",
            },
        }
    }
}

#[derive(Debug, Serialize)]
pub(super) struct EmptyTruncatedPageError {
    error: &'static str,
    detail: String,
    source: &'static str,
    source_mode: &'static str,
    source_label: &'static str,
    feed: String,
    pages_fetched: usize,
    has_more: bool,
    truncated: bool,
}

pub(super) fn empty_truncated_page_error(
    source_mode: &str,
    feed: &str,
    pages_fetched: usize,
    has_more: bool,
) -> EmptyTruncatedPageError {
    let source = MarketSource::new(source_mode, feed);
    EmptyTruncatedPageError {
        error: "market_data_truncated",
        detail: format!(
            "OpenBB market response is truncated after {pages_fetched} pages with no rows; has_more={has_more}."
        ),
        source: source.source,
        source_mode: source.source_mode,
        source_label: source.source_label,
        feed: feed.to_owned(),
        pages_fetched,
        has_more,
        truncated: true,
    }
}

#[derive(Debug, Serialize)]
pub(super) struct StockRow {
    symbol: String,
    last: Option<f64>,
    open: Option<f64>,
    high: Option<f64>,
    low: Option<f64>,
    previous_close: Option<f64>,
    change_percent: Option<f64>,
    bid: Option<f64>,
    ask: Option<f64>,
    volume: Option<f64>,
    last_basis: Option<String>,
    trade_at: Option<String>,
    quote_at: Option<String>,
    daily_bar_at: Option<String>,
    previous_daily_bar_at: Option<String>,
    market_as_of: Option<String>,
    snapshot_present: bool,
    requested_count: usize,
    returned_count: usize,
    price_complete: bool,
    time_complete: bool,
    complete: bool,
    source: &'static str,
    source_mode: &'static str,
    source_label: &'static str,
    feed: String,
    pages_fetched: usize,
    has_more: bool,
    truncated: bool,
}

pub(super) fn stock_rows(
    requested: &[String],
    snapshots: Vec<StockSnapshot>,
    source_mode: &str,
    feed: &str,
) -> Vec<StockRow> {
    let returned_count = snapshots.len();
    let source = MarketSource::new(source_mode, feed);
    let snapshots: HashMap<_, _> = snapshots
        .into_iter()
        .map(|snapshot| (snapshot.symbol.clone(), snapshot))
        .collect();

    requested
        .iter()
        .map(|symbol| {
            let snapshot = snapshots.get(symbol);
            let trade_at = snapshot.and_then(|row| row.updated_at.clone());
            let market_as_of = snapshot.and_then(|row| row.last_as_of.clone());
            let snapshot_present = snapshot.is_some();
            let price_complete = snapshot.is_some_and(|row| row.last.is_some());
            let time_complete =
                snapshot.is_some_and(|row| row.last.is_none() || market_as_of.is_some());
            StockRow {
                symbol: symbol.clone(),
                last: snapshot.and_then(|row| row.last),
                open: snapshot.and_then(|row| row.open),
                high: snapshot.and_then(|row| row.high),
                low: snapshot.and_then(|row| row.low),
                previous_close: snapshot.and_then(|row| row.previous_close),
                change_percent: snapshot.and_then(|row| row.change_percent),
                bid: snapshot.and_then(|row| row.bid),
                ask: snapshot.and_then(|row| row.ask),
                volume: snapshot.and_then(|row| row.volume),
                last_basis: snapshot.and_then(|row| row.last_basis.clone()),
                trade_at,
                quote_at: snapshot.and_then(|row| row.quote_at.clone()),
                daily_bar_at: snapshot.and_then(|row| row.daily_bar_at.clone()),
                previous_daily_bar_at: snapshot.and_then(|row| row.previous_daily_bar_at.clone()),
                market_as_of,
                snapshot_present,
                requested_count: requested.len(),
                returned_count,
                price_complete,
                time_complete,
                complete: snapshot_present && price_complete && time_complete,
                source: source.source,
                source_mode: source.source_mode,
                source_label: source.source_label,
                feed: feed.to_owned(),
                pages_fetched: 1,
                has_more: false,
                truncated: false,
            }
        })
        .collect()
}

#[derive(Debug, Serialize)]
pub(super) struct OptionRow {
    symbol: String,
    underlying: String,
    expiration: String,
    right: eqo_domain::Right,
    strike: f64,
    bid: Option<f64>,
    ask: Option<f64>,
    last: Option<f64>,
    bid_size: Option<f64>,
    ask_size: Option<f64>,
    iv: Option<f64>,
    delta: Option<f64>,
    gamma: Option<f64>,
    theta: Option<f64>,
    vega: Option<f64>,
    quote_at: Option<String>,
    trade_at: Option<String>,
    model_as_of: Option<String>,
    market_as_of: Option<String>,
    source: &'static str,
    source_mode: &'static str,
    source_label: &'static str,
    feed: String,
    pages_fetched: usize,
    has_more: bool,
    truncated: bool,
    complete: bool,
    requested_limit: usize,
}

pub(super) fn option_rows(page: ChainPage, source_mode: &str, feed: &str) -> Vec<OptionRow> {
    let source = MarketSource::new(source_mode, feed);
    let pages_fetched = page.pages_fetched;
    let has_more = page.has_more;
    let truncated = page.truncated;
    let requested_limit = page.limit;
    page.contracts
        .into_iter()
        .map(|contract| {
            option_row(
                contract,
                source,
                feed,
                pages_fetched,
                has_more,
                truncated,
                requested_limit,
            )
        })
        .collect()
}

fn option_row(
    contract: OptionSnapshot,
    source: MarketSource,
    feed: &str,
    pages_fetched: usize,
    has_more: bool,
    truncated: bool,
    requested_limit: usize,
) -> OptionRow {
    let market_as_of = contract
        .quote_at
        .clone()
        .or_else(|| contract.trade_at.clone());
    OptionRow {
        symbol: contract.symbol,
        underlying: contract.underlying,
        expiration: contract.expiration,
        right: contract.right,
        strike: contract.strike,
        bid: contract.bid,
        ask: contract.ask,
        last: contract.last,
        bid_size: contract.bid_size,
        ask_size: contract.ask_size,
        iv: contract.iv,
        delta: contract.delta,
        gamma: contract.gamma,
        theta: contract.theta,
        vega: contract.vega,
        quote_at: contract.quote_at,
        trade_at: contract.trade_at,
        model_as_of: contract.model_as_of,
        market_as_of,
        source: source.source,
        source_mode: source.source_mode,
        source_label: source.source_label,
        feed: feed.to_owned(),
        pages_fetched,
        has_more,
        truncated,
        complete: !truncated,
        requested_limit,
    }
}

#[derive(Debug, Serialize)]
pub(super) struct BarRow {
    time: String,
    market_as_of: String,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
    symbol: String,
    source: &'static str,
    source_mode: &'static str,
    source_label: &'static str,
    feed: String,
    pages_fetched: usize,
    has_more: bool,
    truncated: bool,
    requested_limit: usize,
    returned_count: usize,
    complete: bool,
}

struct BarPageMetadata {
    source: MarketSource,
    feed: String,
    pages_fetched: usize,
    has_more: bool,
    truncated: bool,
    requested_limit: usize,
    returned_count: usize,
}

pub(super) fn bar_rows(symbol: &str, page: BarsPage, source_mode: &str, feed: &str) -> Vec<BarRow> {
    let metadata = BarPageMetadata {
        source: MarketSource::new(source_mode, feed),
        feed: feed.to_owned(),
        pages_fetched: page.pages_fetched,
        has_more: page.has_more,
        truncated: page.truncated,
        requested_limit: page.limit,
        returned_count: page.bars.len(),
    };
    page.bars
        .into_iter()
        .map(|bar| bar_row(symbol, bar, &metadata))
        .collect()
}

fn bar_row(symbol: &str, bar: Bar, metadata: &BarPageMetadata) -> BarRow {
    BarRow {
        market_as_of: bar.time.clone(),
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        symbol: symbol.to_owned(),
        source: metadata.source.source,
        source_mode: metadata.source.source_mode,
        source_label: metadata.source.source_label,
        feed: metadata.feed.clone(),
        pages_fetched: metadata.pages_fetched,
        has_more: metadata.has_more,
        truncated: metadata.truncated,
        requested_limit: metadata.requested_limit,
        returned_count: metadata.returned_count,
        complete: !metadata.truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eqo_domain::Right;

    fn option_snapshot(quote_at: Option<&str>, trade_at: Option<&str>) -> OptionSnapshot {
        OptionSnapshot {
            symbol: "QQQ261009C00600000".into(),
            underlying: "QQQ".into(),
            expiration: "2026-10-09".into(),
            right: Right::Call,
            strike: 600.0,
            bid: Some(1.2),
            ask: Some(1.4),
            last: None,
            bid_size: None,
            ask_size: None,
            iv: Some(0.2),
            delta: Some(0.5),
            gamma: None,
            theta: None,
            vega: None,
            updated_at: quote_at
                .map(str::to_owned)
                .or_else(|| trade_at.map(str::to_owned)),
            quote_at: quote_at.map(str::to_owned),
            trade_at: trade_at.map(str::to_owned),
            model_as_of: None,
            feed: "opra".into(),
        }
    }

    #[test]
    fn option_row_keeps_quote_trade_and_model_times_separate() {
        let page = ChainPage {
            contracts: vec![option_snapshot(Some("quote-time"), Some("trade-time"))],
            pages_fetched: 2,
            has_more: false,
            truncated: false,
            limit: 5000,
        };
        let row = serde_json::to_value(option_rows(page, "alpaca", "opra").remove(0)).unwrap();
        assert_eq!(row["quote_at"], "quote-time");
        assert_eq!(row["trade_at"], "trade-time");
        assert_eq!(row["market_as_of"], "quote-time");
        assert!(row["model_as_of"].is_null());
        assert_eq!(row["source_label"], "Alpaca OPRA");
        assert_eq!(row["pages_fetched"], 2);
        assert_eq!(row["truncated"], false);
    }

    #[test]
    fn unverified_market_endpoint_never_gets_alpaca_source_label() {
        let page = ChainPage {
            contracts: vec![option_snapshot(None, Some("trade-time"))],
            pages_fetched: 1,
            has_more: true,
            truncated: true,
            limit: 5000,
        };
        let row = serde_json::to_value(option_rows(page, "unknown", "opra").remove(0)).unwrap();
        assert_eq!(row["source_mode"], "unknown");
        assert_eq!(row["source_label"], "source unknown");
        assert_eq!(row["market_as_of"], "trade-time");
        assert_eq!(row["has_more"], true);
        assert_eq!(row["truncated"], true);
    }
}
