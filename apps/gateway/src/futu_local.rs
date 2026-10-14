//! Local-only read transport using the official SDK over a private child-process pipe.
//! No listener, browser credential, order operation or provider protocol decoder is added.
use crate::market_stream::{ChannelSymbols, FeedStatusSnapshot, MarketPublisher};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::{Mutex, oneshot, watch},
};

type Reply = Result<Value, String>;

/// Range and pagination fields passed unchanged to the local Futu history helper.
/// The helper response remains a raw `Value` so source timestamps and precision metadata survive.
#[derive(Clone, Debug)]
pub(crate) struct HistoryBarsRequest {
    pub(crate) symbol: String,
    pub(crate) timeframe: String,
    pub(crate) limit: usize,
    pub(crate) days: Option<i64>,
    pub(crate) start: Option<String>,
    pub(crate) end: Option<String>,
    pub(crate) cursor: Option<String>,
}

fn history_bars_payload(query: &HistoryBarsRequest) -> Result<Value, String> {
    if query.start.is_some() != query.end.is_some() {
        return Err("invalid_bars_query".into());
    }
    if query.cursor.as_ref().is_some_and(|cursor| {
        cursor.len() != 32
            || !cursor
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    }) {
        return Err("invalid_cursor".into());
    }
    if query.start.as_ref().is_some_and(|value| value.len() > 35)
        || query.end.as_ref().is_some_and(|value| value.len() > 35)
    {
        return Err("invalid_bars_query".into());
    }
    let mut request = json!({
        "method": "bars",
        "symbol": query.symbol,
        "timeframe": query.timeframe,
        "limit": query.limit,
    });
    if let Some(days) = query.days {
        request["days"] = json!(days);
    }
    if let Some(start) = &query.start {
        request["start"] = json!(start);
    }
    if let Some(end) = &query.end {
        request["end"] = json!(end);
    }
    if let Some(cursor) = &query.cursor {
        request["cursor"] = json!(cursor);
    }
    Ok(request)
}

#[derive(Clone)]
pub(crate) struct FutuLocal {
    input: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>>,
    sequence: Arc<AtomicU64>,
}
impl FutuLocal {
    pub(crate) async fn start(
        publisher: MarketPublisher,
        mut stocks: watch::Receiver<Vec<String>>,
    ) -> Result<Self, String> {
        if std::env::var("FUTU_OPEND_HOST").unwrap_or_else(|_| "127.0.0.1".into()) != "127.0.0.1" {
            return Err("Futu requires loopback OpenD".into());
        }
        let script = std::env::var("EQO_FUTU_SCRIPT").map_err(|_| "EQO_FUTU_SCRIPT required")?;
        let mut command = Command::new("node");
        command.arg(script).env_clear();
        for key in [
            "PATH",
            "HOME",
            "FUTU_OPEND_HOST",
            "FUTU_OPEND_WEBSOCKET_PORT",
            "FUTU_OPEND_WEBSOCKET_SSL",
            "FUTU_OPEND_WEBSOCKET_KEY",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "Futu SDK process unavailable")?;
        let input = child.stdin.take().ok_or("Futu input unavailable")?;
        let output = child.stdout.take().ok_or("Futu output unavailable")?;
        let client = Self {
            input: Arc::new(Mutex::new(input)),
            pending: Arc::default(),
            sequence: Arc::new(AtomicU64::new(0)),
        };
        let pending = client.pending.clone();
        let (connected, mut connected_rx) = watch::channel(false);
        tokio::spawn(async move {
            let mut lines = BufReader::new(output).lines();
            let mut epoch = 0u64;
            while let Ok(Some(line)) = lines.next_line().await {
                if line.len() > 262_144 {
                    break;
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    break;
                };
                if let Some(id) = value["id"].as_u64() {
                    if let Some(reply) = pending.lock().await.remove(&id) {
                        let response = if let Some(error) = value["error"].as_str() {
                            Err(error.to_string())
                        } else {
                            Ok(value["result"].clone())
                        };
                        let _ = reply.send(response);
                    }
                } else if value["kind"] == "connection" {
                    let ready = value["connected"] == true;
                    epoch = epoch.saturating_add(1);
                    connected.send_replace(ready);
                    publisher.publish_status(FeedStatusSnapshot {
                        feed: "stocks".into(),
                        transport: if ready { "connected" } else { "disconnected" }.into(),
                        auth: "unknown".into(),
                        desired: ChannelSymbols::default(),
                        confirmed: None,
                        pending_subscribe: ChannelSymbols::default(),
                        pending_unsubscribe: ChannelSymbols::default(),
                        upstream: if ready { "pending" } else { "degraded" }.into(),
                        coverage_limit: Some(32),
                        coverage_complete: false,
                        connection_epoch: epoch,
                        last_error: None,
                        decode_error_count: 0,
                        resync_required: true,
                    });
                } else {
                    publisher.publish_futu_stock_event(&value, epoch);
                }
            }
            connected.send_replace(false);
            publisher.publish_status(FeedStatusSnapshot {
                feed: "stocks".into(),
                transport: "disconnected".into(),
                auth: "unknown".into(),
                desired: ChannelSymbols::default(),
                confirmed: None,
                pending_subscribe: ChannelSymbols::default(),
                pending_unsubscribe: ChannelSymbols::default(),
                upstream: "degraded".into(),
                coverage_limit: Some(32),
                coverage_complete: false,
                connection_epoch: epoch,
                last_error: None,
                decode_error_count: 0,
                resync_required: true,
            });
            for (_, reply) in pending.lock().await.drain() {
                let _ = reply.send(Err("futu_disconnected".into()));
            }
            let _ = child.kill().await;
        });
        let worker = client.clone();
        tokio::spawn(async move {
            let mut retry = tokio::time::interval(Duration::from_secs(5));
            loop {
                if *connected_rx.borrow() {
                    let desired = stocks.borrow().clone();
                    let _ = worker
                        .request(json!({"method":"subscriptions","symbols":desired}))
                        .await;
                }
                tokio::select! {
                    _ = retry.tick() => {},
                    result = stocks.changed() => { if result.is_err() { break; } },
                    result = connected_rx.changed() => { if result.is_err() { break; } },
                }
            }
        });
        Ok(client)
    }
    pub(crate) async fn request(&self, mut request: Value) -> Reply {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            if pending.len() >= 64 {
                return Err("futu_queue_full".into());
            }
            pending.insert(id, sender);
        }
        request["id"] = json!(id);
        let line = format!("{request}\n");
        if self
            .input
            .lock()
            .await
            .write_all(line.as_bytes())
            .await
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            return Err("futu_disconnected".into());
        }
        let response = tokio::time::timeout(Duration::from_secs(15), receiver).await;
        self.pending.lock().await.remove(&id);
        response
            .map_err(|_| "futu_timeout".to_string())?
            .map_err(|_| "futu_disconnected".to_string())?
    }

    /// Request one history page from the existing loopback worker, preserving its raw metadata.
    pub(crate) async fn history_bars(&self, query: &HistoryBarsRequest) -> Reply {
        self.request(history_bars_payload(query)?).await
    }
}

#[cfg(test)]
mod tests {
    use super::{HistoryBarsRequest, history_bars_payload};
    use serde_json::json;

    fn query() -> HistoryBarsRequest {
        HistoryBarsRequest {
            symbol: "AAPL".into(),
            timeframe: "1Min".into(),
            limit: 500,
            days: None,
            start: Some("2026-10-14T13:30:00.000Z".into()),
            end: Some("2026-10-14T14:30:00+00:00".into()),
            cursor: Some("o".repeat(32)),
        }
    }

    #[test]
    fn history_payload_preserves_range_and_cursor_without_normalizing_them() {
        let value = history_bars_payload(&query()).unwrap();
        assert_eq!(
            value,
            json!({
                "method": "bars",
                "symbol": "AAPL",
                "timeframe": "1Min",
                "limit": 500,
                "start": "2026-10-14T13:30:00.000Z",
                "end": "2026-10-14T14:30:00+00:00",
                "cursor": "oooooooooooooooooooooooooooooooo",
            })
        );
    }

    #[test]
    fn legacy_days_remain_available_and_mismatched_ranges_fail_closed() {
        let mut legacy = query();
        legacy.start = None;
        legacy.end = None;
        legacy.cursor = None;
        legacy.days = Some(30);
        assert_eq!(history_bars_payload(&legacy).unwrap()["days"], 30);

        legacy.end = Some("2026-10-14T14:30:00Z".into());
        assert_eq!(
            history_bars_payload(&legacy).unwrap_err(),
            "invalid_bars_query"
        );
    }

    #[test]
    fn cursor_is_bounded_before_it_reaches_the_worker_pipe() {
        let mut query = query();
        query.cursor = Some("x".repeat(16_384));
        assert_eq!(history_bars_payload(&query).unwrap_err(), "invalid_cursor");
    }
}
