//! HTTP/WS gateway. Credentials and broker execution remain server-side.
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, Request, State,
    },
    http::{header, HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use chrono::{NaiveDate, Utc};
use eqo_alpaca_data::{AlpacaData, DataError};
use eqo_domain::{parse_occ, MarketEvent};
use eqo_execution::{BrokerRouter, OrderError, OrderIntent, PreviewStore, RiskPolicy};
use futures_util::stream::{self, Stream};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    fs::{self, OpenOptions},
    io::AsyncWriteExt,
    sync::{broadcast, watch, Mutex, RwLock},
};
use tower_http::{cors::CorsLayer, services::ServeDir, trace::TraceLayer};
use tracing::{error, info, warn};
use uuid::Uuid;

type ConsumerLeases = HashMap<Uuid, (Instant, HashSet<String>)>;

#[derive(Clone)]
struct AppState {
    data: Option<AlpacaData>,
    stock_feed: String,
    option_feed: String,
    execution_enabled: bool,
    token: Option<String>,
    stock_symbols: Vec<String>,
    max_stock_subscriptions: usize,
    stock_tx: watch::Sender<Vec<String>>,
    stock_leases: Arc<Mutex<ConsumerLeases>>,
    max_option_subscriptions: usize,
    option_tx: watch::Sender<Vec<String>>,
    option_leases: Arc<Mutex<ConsumerLeases>>,
    broadcasts: broadcast::Sender<MarketEvent>,
    tickets: Arc<Mutex<HashMap<Uuid, Instant>>>,
    previews: PreviewStore,
    risk: RiskPolicy,
    brokers: BrokerRouter,
    audit_path: String,
    audit_lock: Arc<Mutex<()>>,
    chains: Arc<RwLock<HashMap<String, (Instant, Value)>>>,
}

#[derive(Debug, Serialize)]
struct ApiError {
    error: &'static str,
    detail: String,
}
fn fail(status: StatusCode, error: &'static str, detail: impl Into<String>) -> Response {
    (
        status,
        Json(ApiError {
            error,
            detail: detail.into(),
        }),
    )
        .into_response()
}
fn data_failure(err: DataError) -> Response {
    fail(err.status_code(), "market_data_error", err.to_string())
}
fn order_failure(err: OrderError) -> Response {
    let status = match err {
        OrderError::LiveForbidden | OrderError::Invalid(_) | OrderError::RiskLimit => {
            StatusCode::UNPROCESSABLE_ENTITY
        }
        OrderError::Disabled | OrderError::MissingAdapter => StatusCode::SERVICE_UNAVAILABLE,
        OrderError::Expired => StatusCode::CONFLICT,
        OrderError::Rejected => StatusCode::UNPROCESSABLE_ENTITY,
        OrderError::UnknownState => StatusCode::BAD_GATEWAY,
    };
    fail(status, "order_error", err.to_string())
}
fn safe_symbol(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 12
        && s.bytes()
            .all(|b| b.is_ascii_uppercase() || b == b'.' || b == b'-')
}

fn stock_subscription_union(base: &[String], leases: &ConsumerLeases) -> Vec<String> {
    let mut combined: HashSet<String> = base.iter().cloned().collect();
    combined.extend(leases.values().flat_map(|(_, set)| set.iter().cloned()));
    let mut sorted: Vec<String> = combined.into_iter().collect();
    sorted.sort();
    sorted
}

fn option_subscription_union(leases: &ConsumerLeases) -> Vec<String> {
    let mut combined: Vec<String> = leases
        .values()
        .flat_map(|(_, set)| set.iter().cloned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    combined.sort();
    combined
}

async fn require_auth(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if let Some(expected) = &state.token {
        let provided = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "));
        if provided != Some(expected.as_str()) {
            return fail(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "bearer token required",
            );
        }
    }
    next.run(request).await
}

async fn healthz() -> impl IntoResponse {
    Json(json!({"status":"ok","service":"eqo-gateway"}))
}
async fn status(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "service":"EqoBoard", "schema_version":1,
        "market_credentials_present":state.data.is_some(),
        "stock_feed":state.stock_feed,"option_feed":state.option_feed,
        "market_data_provider":"alpaca",
        "execution_mode":if state.execution_enabled {"paper"} else {"disabled"},
        "configured_adapters":state.brokers.configured(),
        "max_stock_subscriptions":state.max_stock_subscriptions,
        "active_stock_subscriptions":state.stock_tx.borrow().len(),
        "max_option_subscriptions":state.max_option_subscriptions,
        "active_option_subscriptions":state.option_tx.borrow().len(),
        "stock_symbols":state.stock_symbols,
        "as_of":Utc::now().to_rfc3339(),
        "notes":"configured feeds do not imply entitlements; upstream 403 remains explicit"
    }))
}

#[derive(Deserialize)]
struct SymbolsQuery {
    symbols: Option<String>,
}
async fn stock_snapshots(
    State(state): State<AppState>,
    Query(query): Query<SymbolsQuery>,
) -> Response {
    let Some(data) = &state.data else {
        return data_failure(DataError::MissingCredentials);
    };
    let symbols = query
        .symbols
        .unwrap_or_else(|| state.stock_symbols.join(","));
    let list: Vec<String> = symbols
        .split(',')
        .map(|s| s.trim().to_uppercase())
        .collect();
    if list.is_empty() || list.len() > 50 || list.iter().any(|s| !safe_symbol(s)) {
        return fail(
            StatusCode::BAD_REQUEST,
            "invalid_symbols",
            "1..50 valid uppercase stock tickers required",
        );
    }
    match data.stock_snapshots(&list).await {
        Ok(snapshots) => Json(json!({"source":"alpaca","feed":state.stock_feed,
            "as_of":Utc::now().to_rfc3339(),"snapshots":snapshots}))
        .into_response(),
        Err(err) => data_failure(err),
    }
}

#[derive(Deserialize)]
struct BarsQuery {
    symbol: String,
    timeframe: Option<String>,
    limit: Option<usize>,
    days: Option<i64>,
}
async fn stock_bars(State(state): State<AppState>, Query(query): Query<BarsQuery>) -> Response {
    let Some(data) = &state.data else {
        return data_failure(DataError::MissingCredentials);
    };
    let symbol = query.symbol.to_uppercase();
    let timeframe = query.timeframe.unwrap_or_else(|| "1Min".into());
    if !safe_symbol(&symbol)
        || !["1Min", "5Min", "15Min", "1Hour", "1Day", "1Week", "1Month"]
            .contains(&timeframe.as_str())
    {
        return fail(
            StatusCode::BAD_REQUEST,
            "invalid_bars_query",
            "invalid ticker/timeframe",
        );
    }
    let limit = query.limit.unwrap_or(200);
    if !(1..=1000).contains(&limit) {
        return fail(StatusCode::BAD_REQUEST, "invalid_limit", "1..1000");
    }
    let days = query.days.unwrap_or(14);
    if !(1..=11000).contains(&days) {
        return fail(
            StatusCode::BAD_REQUEST,
            "invalid_days",
            "days must be 1..11000",
        );
    }
    match data.stock_bars(&symbol, &timeframe, limit, days).await {
        Ok(bars) => {
            Json(json!({"symbol":symbol,"timeframe":timeframe,"feed":state.stock_feed,"bars":bars}))
                .into_response()
        }
        Err(err) => data_failure(err),
    }
}

#[derive(Deserialize)]
struct ChainQuery {
    underlying: String,
    expiration: String,
    strike_gte: Option<f64>,
    strike_lte: Option<f64>,
}
async fn option_chain(State(state): State<AppState>, Query(query): Query<ChainQuery>) -> Response {
    let Some(data) = &state.data else {
        return data_failure(DataError::MissingCredentials);
    };
    let underlying = query.underlying.to_uppercase();
    if !safe_symbol(&underlying)
        || NaiveDate::parse_from_str(&query.expiration, "%Y-%m-%d").is_err()
        || query.strike_gte.is_some_and(|x| !x.is_finite() || x < 0.0)
        || query.strike_lte.is_some_and(|x| !x.is_finite() || x <= 0.0)
        || query
            .strike_gte
            .zip(query.strike_lte)
            .is_some_and(|(a, b)| a >= b)
    {
        return fail(
            StatusCode::BAD_REQUEST,
            "invalid_chain_query",
            "ticker/date/strike invalid",
        );
    }
    let cache_key = format!(
        "{underlying}/{}:{:?}:{:?}",
        query.expiration, query.strike_gte, query.strike_lte
    );
    if let Some((then, cached)) = state.chains.read().await.get(&cache_key) {
        if then.elapsed() < Duration::from_secs(3) {
            return Json(cached.clone()).into_response();
        }
    }
    match data
        .option_chain(
            &underlying,
            &query.expiration,
            query.strike_gte,
            query.strike_lte,
        )
        .await
    {
        Ok(page) => {
            let body = json!({"underlying":underlying,"expiration":query.expiration,
                "feed":state.option_feed,"source":"alpaca","as_of":Utc::now().to_rfc3339(),
                "truncated":page.truncated,"contracts":page.contracts});
            let mut cache = state.chains.write().await;
            if cache.len() > 50 {
                cache.clear();
            }
            cache.insert(cache_key, (Instant::now(), body.clone()));
            Json(body).into_response()
        }
        Err(err) => data_failure(err),
    }
}

/// OpenBB Workspace fetches these metadata descriptors via the configured data connector.
async fn openbb_widgets() -> Json<Value> {
    Json(
        serde_json::from_str(include_str!("../openbb/widgets.json"))
            .expect("bundled OpenBB widgets.json must be valid JSON"),
    )
}
async fn openbb_apps() -> Json<Value> {
    Json(
        serde_json::from_str(include_str!("../openbb/apps.json"))
            .expect("bundled OpenBB apps.json must be valid JSON"),
    )
}

/// OpenBB AG Grid consumes flat arrays. The existing SIP source and as-of fields are preserved.
async fn openbb_stocks(
    State(state): State<AppState>,
    Query(query): Query<SymbolsQuery>,
) -> Response {
    let Some(data) = &state.data else {
        return data_failure(DataError::MissingCredentials);
    };
    let raw = query.symbols.unwrap_or_else(|| "QQQ,SPY,NVDA".into());
    let symbols: Vec<String> = raw.split(',').map(|x| x.trim().to_uppercase()).collect();
    if symbols.is_empty() || symbols.len() > 50 || symbols.iter().any(|x| !safe_symbol(x)) {
        return fail(
            StatusCode::BAD_REQUEST,
            "invalid_symbols",
            "1..50 valid symbols required",
        );
    }
    if state.stock_feed != "sip" {
        return fail(
            StatusCode::CONFLICT,
            "invalid_feed",
            "OpenBB SIP widget requires SIP entitlement",
        );
    }
    match data.stock_snapshots(&symbols).await {
        Ok(rows) => Json(json!(rows)).into_response(),
        Err(err) => data_failure(err),
    }
}

/// The IV and Greeks are snapshots, not synchronized executable combo prices.
async fn openbb_options(
    State(state): State<AppState>,
    Query(query): Query<ChainQuery>,
) -> Response {
    let Some(data) = &state.data else {
        return data_failure(DataError::MissingCredentials);
    };
    let symbol = query.underlying.to_uppercase();
    if !safe_symbol(&symbol) || NaiveDate::parse_from_str(&query.expiration, "%Y-%m-%d").is_err() {
        return fail(
            StatusCode::BAD_REQUEST,
            "invalid_options_query",
            "ticker or expiration invalid",
        );
    }
    if state.option_feed != "opra" {
        return fail(
            StatusCode::CONFLICT,
            "invalid_feed",
            "OpenBB OPRA widget requires OPRA entitlement",
        );
    }
    match data
        .option_chain(&symbol, &query.expiration, None, None)
        .await
    {
        Ok(page) => {
            let rows: Vec<Value> = page
                .contracts
                .into_iter()
                .map(|contract| {
                    let mut row = serde_json::to_value(contract).expect("serialized contract");
                    if let Some(map) = row.as_object_mut() {
                        map.insert("truncated".into(), json!(page.truncated));
                    }
                    row
                })
                .collect();
            Json(json!(rows)).into_response()
        }
        Err(err) => data_failure(err),
    }
}
async fn openbb_bars(State(state): State<AppState>, Query(query): Query<BarsQuery>) -> Response {
    let Some(data) = &state.data else {
        return data_failure(DataError::MissingCredentials);
    };
    let symbol = query.symbol.to_uppercase();
    let timeframe = query.timeframe.unwrap_or_else(|| "1Day".into());
    let limit = query.limit.unwrap_or(500);
    let days = query.days.unwrap_or(30);
    if !safe_symbol(&symbol)
        || !(1..=1000).contains(&limit)
        || !(1..=11000).contains(&days)
        || !["1Min", "5Min", "15Min", "1Hour", "1Day", "1Week", "1Month"]
            .contains(&timeframe.as_str())
    {
        return fail(
            StatusCode::BAD_REQUEST,
            "invalid_bars_query",
            "invalid ticker/timeframe/window",
        );
    }
    if state.stock_feed != "sip" {
        return fail(
            StatusCode::CONFLICT,
            "invalid_feed",
            "OpenBB SIP widget requires SIP entitlement",
        );
    }
    match data.stock_bars(&symbol, &timeframe, limit, days).await {
        Ok(bars) => {
            let rows: Vec<Value> = bars
                .into_iter()
                .map(|bar| {
                    json!({"time":bar.time,"open":bar.open,"high":bar.high,"low":bar.low,
                    "close":bar.close,"volume":bar.volume,"symbol":symbol,"feed":"sip"})
                })
                .collect();
            Json(json!(rows)).into_response()
        }
        Err(err) => data_failure(err),
    }
}

#[derive(Deserialize)]
struct SubscribeSymbols {
    consumer_id: Uuid,
    symbols: Vec<String>,
}
async fn stock_subscribe(
    State(state): State<AppState>,
    Json(body): Json<SubscribeSymbols>,
) -> Response {
    if body.symbols.len() > state.max_stock_subscriptions {
        return fail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "subscription_limit",
            "too many stock symbols",
        );
    }
    let mut wanted = HashSet::new();
    for symbol in body.symbols {
        let normalized = symbol.trim().to_uppercase();
        if !safe_symbol(&normalized) {
            return fail(StatusCode::BAD_REQUEST, "invalid_symbol", "invalid stock symbol");
        }
        wanted.insert(normalized);
    }
    let mut leases = state.stock_leases.lock().await;
    leases.retain(|_, (until, _)| *until > Instant::now());
    leases.insert(
        body.consumer_id,
        (Instant::now() + Duration::from_secs(90), wanted),
    );
    let sorted = stock_subscription_union(&state.stock_symbols, &leases);
    if sorted.len() > state.max_stock_subscriptions {
        leases.remove(&body.consumer_id);
        return fail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "subscription_limit",
            "global SIP stream capacity exceeded",
        );
    }
    state.stock_tx.send_replace(sorted.clone());
    Json(json!({
        "active":sorted.len(),
        "max":state.max_stock_subscriptions,
        "expires_in_seconds":90
    }))
    .into_response()
}

async fn option_subscribe(
    State(state): State<AppState>,
    Json(body): Json<SubscribeSymbols>,
) -> Response {
    if body.symbols.len() > state.max_option_subscriptions {
        return fail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "subscription_limit",
            "too many symbols",
        );
    }
    let mut wanted = HashSet::new();
    for symbol in body.symbols {
        if parse_occ(&symbol).is_err() {
            return fail(
                StatusCode::BAD_REQUEST,
                "invalid_occ",
                "invalid option contract",
            );
        }
        wanted.insert(symbol);
    }
    let mut leases = state.option_leases.lock().await;
    leases.retain(|_, (until, _)| *until > Instant::now());
    leases.insert(
        body.consumer_id,
        (Instant::now() + Duration::from_secs(90), wanted),
    );
    let sorted = option_subscription_union(&leases);
    if sorted.len() > state.max_option_subscriptions {
        leases.remove(&body.consumer_id);
        return fail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "subscription_limit",
            "global OPRA stream capacity exceeded",
        );
    }
    state.option_tx.send_replace(sorted.clone());
    Json(
        json!({"active":sorted.len(),"max":state.max_option_subscriptions,
        "expires_in_seconds":90}),
    )
    .into_response()
}

async fn prune_leases(state: AppState) {
    let mut timer = tokio::time::interval(Duration::from_secs(30));
    loop {
        timer.tick().await;

        {
            let mut leases = state.option_leases.lock().await;
            let before = leases.len();
            leases.retain(|_, (until, _)| *until > Instant::now());
            if before != leases.len() {
                state.option_tx.send_replace(option_subscription_union(&leases));
            }
        }

        {
            let mut leases = state.stock_leases.lock().await;
            let before = leases.len();
            leases.retain(|_, (until, _)| *until > Instant::now());
            if before != leases.len() {
                state
                    .stock_tx
                    .send_replace(stock_subscription_union(&state.stock_symbols, &leases));
            }
        }
    }
}

async fn create_ticket(State(state): State<AppState>) -> Response {
    let mut tickets = state.tickets.lock().await;
    tickets.retain(|_, end| *end > Instant::now());
    if tickets.len() >= 1000 {
        return fail(
            StatusCode::TOO_MANY_REQUESTS,
            "ticket_limit",
            "too many active tickets",
        );
    }
    let ticket = Uuid::new_v4();
    tickets.insert(ticket, Instant::now() + Duration::from_secs(15));
    Json(json!({"ticket":ticket.to_string(),"expires_in_seconds":15})).into_response()
}
#[derive(Deserialize)]
struct TicketQuery {
    ticket: Uuid,
}
async fn market_ws(
    State(state): State<AppState>,
    Query(ticket): Query<TicketQuery>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    // Browser WS has no Authorization header; a single-use 15-second ticket is obtained via authenticated POST.
    if let (Some(origin), Some(host)) = (headers.get(header::ORIGIN), headers.get(header::HOST)) {
        let valid = origin
            .to_str()
            .ok()
            .and_then(|o| o.parse::<axum::http::Uri>().ok())
            .and_then(|u| u.authority().map(|a| a.as_str().to_owned()))
            == host.to_str().ok().map(str::to_owned);
        if !valid {
            return fail(
                StatusCode::FORBIDDEN,
                "origin",
                "cross-origin WebSocket rejected",
            );
        }
    }
    let valid = state
        .tickets
        .lock()
        .await
        .remove(&ticket.ticket)
        .is_some_and(|expires| expires > Instant::now());
    if !valid {
        return fail(StatusCode::UNAUTHORIZED, "ticket", "expired/used WS ticket");
    }
    upgrade
        .on_upgrade(move |ws| stream_to_browser(ws, state.broadcasts.subscribe()))
        .into_response()
}

async fn stream_to_browser(mut ws: WebSocket, mut rx: broadcast::Receiver<MarketEvent>) {
    let mut flush = tokio::time::interval(Duration::from_millis(50));
    let mut batch: Vec<MarketEvent> = Vec::with_capacity(256);
    loop {
        tokio::select! {
            received = rx.recv() => match received {
                Ok(event) => {
                    if batch.len() >= 512 {
                        batch.clear();
                        batch.push(MarketEvent::FeedStatus { feed:"all".into(),
                            state:"resync_required".into(), timestamp:Utc::now().to_rfc3339() });
                    }
                    batch.push(event);
                },
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    batch.clear();
                    batch.push(MarketEvent::FeedStatus { feed:"all".into(),
                        state:"resync_required".into(), timestamp:Utc::now().to_rfc3339() });
                },
                Err(_) => break,
            },
            _ = flush.tick() => if !batch.is_empty() {
                match serde_json::to_string(&batch) {
                    Ok(payload) => if ws.send(Message::Text(payload.into())).await.is_err() { break },
                    Err(_) => break,
                }
                batch.clear();
            },
            msg = ws.recv() => match msg {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {},
            },
        }
    }
}

/// Same normalized market broadcast used by the existing WebSocket terminal.
/// Next.js serves it to the OpenTerminal browser with credentials kept server-side.
async fn live_sse(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut timer = tokio::time::interval(Duration::from_millis(50));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let events = stream::unfold(
        (
            state.broadcasts.subscribe(),
            Vec::<MarketEvent>::new(),
            timer,
        ),
        |(mut rx, mut batch, mut flush)| async move {
            loop {
                tokio::select! {
                    event = rx.recv() => match event {
                        Ok(event) => {
                            if batch.len() >= 512 {
                                batch.clear();
                                batch.push(MarketEvent::FeedStatus {
                                    feed: "all".into(),
                                    state: "resync_required".into(),
                                    timestamp: Utc::now().to_rfc3339(),
                                });
                            }
                            batch.push(event);
                        },
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            batch.clear();
                            batch.push(MarketEvent::FeedStatus {
                                feed: "all".into(),
                                state: "resync_required".into(),
                                timestamp: Utc::now().to_rfc3339(),
                            });
                        },
                        Err(broadcast::error::RecvError::Closed) => return None,
                    },
                    _ = flush.tick(), if !batch.is_empty() => break,
                }
                if batch.len() >= 256 {
                    break;
                }
            }
            let json = serde_json::to_string(&batch).unwrap_or_else(|_| "[]".into());
            Some((Ok(Event::default().data(json)), (rx, Vec::new(), flush)))
        },
    );
    Sse::new(events).keep_alive(KeepAlive::default())
}

#[derive(Deserialize)]
struct SubmitPreview {
    preview_id: Uuid,
    confirm: bool,
}

async fn order_preview(State(state): State<AppState>, Json(order): Json<OrderIntent>) -> Response {
    match state.previews.create(order, state.risk).await {
        Ok(preview) => Json(json!({"preview":preview,"execution_enabled":state.execution_enabled}))
            .into_response(),
        Err(err) => order_failure(err),
    }
}

async fn audit(
    state: &AppState,
    order_id: Uuid,
    broker: &str,
    status: &str,
) -> std::io::Result<()> {
    let _guard = state.audit_lock.lock().await;
    let path = PathBuf::from(&state.audit_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
        .await?;
    let record = json!({"client_order_id":order_id,"broker":broker,
        "state":status,"time":Utc::now().to_rfc3339()});
    file.write_all(record.to_string().as_bytes()).await?;
    file.write_all(b"\n").await?;
    file.sync_data().await?;
    Ok(())
}

async fn order_submit(State(state): State<AppState>, Json(body): Json<SubmitPreview>) -> Response {
    if !state.execution_enabled {
        return order_failure(OrderError::Disabled);
    }
    if !body.confirm {
        return fail(
            StatusCode::BAD_REQUEST,
            "confirmation_required",
            "explicit confirm=true required",
        );
    }
    let intent = match state.previews.consume(body.preview_id).await {
        Ok(o) => o,
        Err(err) => return order_failure(err),
    };
    if let Err(err) = eqo_execution::validate_order(&intent, state.risk) {
        return order_failure(err);
    }
    let broker = intent.broker.name();
    let id = Uuid::new_v4();
    // Fail-closed if audit cannot be durably appended.
    if let Err(err) = audit(&state, id, broker, "attempted").await {
        error!(error=%err,"audit write failed - order blocked");
        return fail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "audit_unavailable",
            "order blocked",
        );
    }
    match state.brokers.submit(id, &intent).await {
        Ok(ack) => {
            if let Err(err) = audit(&state, id, broker, &ack.status).await {
                error!(error=%err,"post-submission audit write failed");
            }
            Json(json!({"client_order_id":id,"ack":ack})).into_response()
        }
        Err(err) => {
            let state_name = if matches!(err, OrderError::UnknownState) {
                "unknown"
            } else {
                "rejected"
            };
            if let Err(audit_err) = audit(&state, id, broker, state_name).await {
                error!(error=%audit_err,"post-submission audit failed");
            }
            // Return id so a timeout can be reconciled; never silently retry.
            let status = if matches!(err, OrderError::UnknownState) {
                StatusCode::BAD_GATEWAY
            } else {
                StatusCode::UNPROCESSABLE_ENTITY
            };
            (
                status,
                Json(json!({"error":"order_failed","detail":err.to_string(),
                "client_order_id":id})),
            )
                .into_response()
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "eqo_gateway=info,eqo_alpaca_data=info".into()),
        )
        .init();
    let bind = std::env::var("EQO_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let addr: SocketAddr = bind.parse()?;
    let token = std::env::var("EQO_ACCESS_TOKEN")
        .ok()
        .filter(|s| !s.is_empty());
    if !addr.ip().is_loopback() && token.is_none() {
        return Err("non-loopback bind requires EQO_ACCESS_TOKEN".into());
    }
    let mode = std::env::var("EQO_EXECUTION_MODE").unwrap_or_else(|_| "disabled".into());
    if !["disabled", "paper"].contains(&mode.as_str()) {
        return Err("only disabled and paper execution modes are allowed".into());
    }
    let data = match AlpacaData::from_env() {
        Ok(c) => Some(c),
        Err(err) => {
            warn!(error=%err,"market data source not ready");
            None
        }
    };
    let stock_feed = data
        .as_ref()
        .map(|c| c.stock_feed.clone())
        .unwrap_or_else(|| std::env::var("EQO_STOCK_FEED").unwrap_or_else(|_| "sip".into()));
    let option_feed = data
        .as_ref()
        .map(|c| c.option_feed.clone())
        .unwrap_or_else(|| std::env::var("EQO_OPTION_FEED").unwrap_or_else(|_| "opra".into()));
    let stocks: Vec<String> = std::env::var("EQO_STOCK_SYMBOLS")
        .unwrap_or_else(|_| "SPY,QQQ,IWM,NVDA,TSLA".into())
        .split(',')
        .map(|s| s.trim().to_uppercase())
        .filter(|s| safe_symbol(s))
        .collect();
    let (stock_tx, stock_rx) = watch::channel(stocks.clone());
    let (option_tx, option_rx) = watch::channel(Vec::<String>::new());
    let max_stock_subscriptions = std::env::var("EQO_MAX_STOCK_SUBSCRIPTIONS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(100)
        .max(stocks.len())
        .min(1000);
    let (broadcasts, _) = broadcast::channel(4096);
    let risk = RiskPolicy::from_env();
    let state = AppState {
        data: data.clone(),
        stock_feed,
        option_feed,
        execution_enabled: mode == "paper",
        token,
        stock_symbols: stocks,
        max_stock_subscriptions,
        stock_tx: stock_tx.clone(),
        stock_leases: Arc::default(),
        max_option_subscriptions: std::env::var("EQO_MAX_OPTION_SUBSCRIPTIONS")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(500)
            .clamp(1, 1000),
        option_tx,
        option_leases: Arc::default(),
        broadcasts: broadcasts.clone(),
        tickets: Arc::default(),
        previews: PreviewStore::default(),
        risk,
        brokers: BrokerRouter::from_env(),
        audit_path: std::env::var("EQO_AUDIT_PATH")
            .unwrap_or_else(|_| "./audit/order-events.jsonl".into()),
        audit_lock: Arc::default(),
        chains: Arc::default(),
    };
    if let Some(data) = data {
        let quotes = data.clone();
        let tx = broadcasts.clone();
        tokio::spawn(async move { quotes.stream(false, stock_rx, tx).await });
        let tx = broadcasts.clone();
        tokio::spawn(async move { data.stream(true, option_rx, tx).await });
    } else {
        warn!("missing market data credentials; API returns 503, no fake prices");
    }
    tokio::spawn(prune_leases(state.clone()));
    let api = Router::new()
        .route("/api/v1/status", get(status))
        .route("/api/v1/stream/sse", get(live_sse))
        .route("/api/v1/stocks/snapshots", get(stock_snapshots))
        .route("/api/v1/stocks/bars", get(stock_bars))
        .route("/api/v1/options/chain", get(option_chain))
        .route("/api/v1/subscriptions/stocks", post(stock_subscribe))
        .route("/api/v1/subscriptions/options", post(option_subscribe))
        .route("/api/v1/auth/ws-ticket", post(create_ticket))
        .route("/api/v1/orders/preview", post(order_preview))
        .route("/api/v1/orders/submit", post(order_submit))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));
    let web_dist = std::env::var("EQO_WEB_DIST").unwrap_or_else(|_| "./apps/gateway/empty".into());
    let openbb_api = Router::new()
        .route("/openbb/v1/stocks", get(openbb_stocks))
        .route("/openbb/v1/options", get(openbb_options))
        .route("/openbb/v1/bars", get(openbb_bars))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));
    let mut app = Router::new()
        .route("/widgets.json", get(openbb_widgets))
        .route("/apps.json", get(openbb_apps))
        .route("/healthz", get(healthz))
        .route("/api/v1/stream", get(market_ws))
        .merge(api)
        .merge(openbb_api)
        .fallback_service(ServeDir::new(web_dist).append_index_html_on_directories(true))
        .layer(TraceLayer::new_for_http())
        .with_state(state);
    if let Some(raw) = std::env::var("EQO_OPENBB_ALLOWED_ORIGIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        let local_http =
            raw.starts_with("http://127.0.0.1:") || raw.starts_with("http://localhost:");
        if raw == "*" || !(raw.starts_with("https://") || local_http) {
            return Err("EQO_OPENBB_ALLOWED_ORIGIN requires HTTPS or loopback HTTP".into());
        }
        let origin: axum::http::HeaderValue = raw.parse()?;
        app = app.layer(
            CorsLayer::new()
                .allow_origin(origin)
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
                .allow_methods([Method::GET, Method::OPTIONS]),
        );
    }
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(addr=%addr,"EqoBoard listening");
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn subscription_unions_are_sorted_and_deduplicated() {
        let now = Instant::now() + Duration::from_secs(60);
        let mut leases = ConsumerLeases::new();
        leases.insert(
            Uuid::nil(),
            (
                now,
                ["QQQ".to_string(), "NVDA".to_string()]
                    .into_iter()
                    .collect(),
            ),
        );
        assert_eq!(
            stock_subscription_union(&["SPY".into(), "QQQ".into()], &leases),
            vec!["NVDA".to_string(), "QQQ".to_string(), "SPY".to_string()]
        );
        assert_eq!(
            option_subscription_union(&leases),
            vec!["NVDA".to_string(), "QQQ".to_string()]
        );
    }
    #[test]
    fn symbols_validated() {
        assert!(safe_symbol("SPY"));
        assert!(safe_symbol("BRK.B"));
        assert!(!safe_symbol("SPY/../../secrets"));
    }
}
