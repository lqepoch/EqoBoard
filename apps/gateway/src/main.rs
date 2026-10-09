//! HTTP/WS gateway. Credentials and broker execution remain server-side.
mod market_stream;
mod openbb;
mod option_supervisor;

#[cfg(test)]
mod openbb_tests;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Extension, Query, Request, State,
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
use eqo_domain::parse_occ;
use eqo_execution::{
    BrokerRouter, OrderError, OrderIntent, PreviewOwner, PreviewStore, RiskPolicy,
};
use futures_util::stream;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
#[cfg(test)]
use market_stream::{ChannelSymbols, FeedStatusSnapshot};
use market_stream::{
    GatewayMarketEvent, MarketPublisher, OptionSubscriptionRevision, MAX_BROKER_OPTION_SYMBOLS,
};
#[cfg(test)]
use market_stream::{OPTION_FEED_NAME, STOCK_FEED_NAME};
use option_supervisor::{alpaca_opra_port, run_option_market_stream};
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

type ConsumerKey = (String, String, Uuid);
type ConsumerLeases = HashMap<ConsumerKey, (Instant, HashSet<String>)>;
type OptionConsumerLeases = HashMap<ConsumerKey, OptionLease>;
type WebSocketTicket = (Instant, String, String);
type WebSocketTickets = HashMap<Uuid, WebSocketTicket>;

#[derive(Clone)]
struct OptionLease {
    expires_at: Instant,
    generation: u64,
    symbols: HashSet<String>,
}

const BFF_ISSUER: &str = "eqoboard-openterminal";
const RESEARCH_ISSUER: &str = "openterminal-research";
const GATEWAY_AUDIENCE: &str = "eqoboard-gateway";

#[derive(Clone, Default)]
struct AuthKeyring {
    bff: Option<Arc<Vec<u8>>>,
    research: Option<Arc<Vec<u8>>>,
}

impl AuthKeyring {
    fn from_env() -> Self {
        Self {
            bff: env_secret("EQO_GATEWAY_JWT_SECRET"),
            research: env_secret("EQO_RESEARCH_JWT_SECRET"),
        }
    }

    fn ready(&self) -> bool {
        self.bff
            .as_deref()
            .zip(self.research.as_deref())
            .is_some_and(|(bff, research)| bff != research)
    }
}

fn env_secret(name: &str) -> Option<Arc<Vec<u8>>> {
    std::env::var(name)
        .ok()
        .filter(|secret| secret.len() >= 64 && secret.is_ascii())
        .map(|secret| Arc::new(secret.into_bytes()))
}

#[derive(Debug, Clone, Deserialize)]
struct DelegationClaims {
    sub: String,
    iss: String,
    aud: String,
    exp: usize,
    iat: usize,
    jti: String,
    idp_iss: String,
    scope: Vec<String>,
}

#[derive(Debug, Clone)]
struct GatewayPrincipal {
    subject: String,
    identity_issuer: String,
    scopes: HashSet<String>,
}

impl GatewayPrincipal {
    fn has_scope(&self, scope: &str) -> bool {
        self.scopes.contains(scope)
    }

    fn preview_owner(&self) -> PreviewOwner {
        PreviewOwner::new(self.identity_issuer.clone(), self.subject.clone())
    }
}

#[derive(Clone)]
struct AppState {
    data: Option<AlpacaData>,
    stock_feed: String,
    option_feed: String,
    requested_execution_mode: String,
    execution_enabled: bool,
    auth_keys: AuthKeyring,
    stock_symbols: Vec<String>,
    max_stock_subscriptions: usize,
    stock_tx: watch::Sender<Vec<String>>,
    stock_leases: Arc<Mutex<ConsumerLeases>>,
    max_option_subscriptions: usize,
    option_tx: watch::Sender<OptionSubscriptionRevision>,
    option_leases: Arc<Mutex<OptionConsumerLeases>>,
    market_publisher: MarketPublisher,
    tickets: Arc<Mutex<WebSocketTickets>>,
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
#[derive(Debug, Serialize)]
struct OrderOutcomeError {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_order_id: Option<String>,
    retryable: bool,
    recovery_required: bool,
    detail: String,
}

fn order_outcome_error(
    status: StatusCode,
    state: &'static str,
    client_order_id: Option<Uuid>,
    recovery_required: bool,
    detail: impl Into<String>,
) -> Response {
    (
        status,
        Json(OrderOutcomeError {
            state,
            client_order_id: client_order_id.map(|id| id.to_string()),
            retryable: false,
            recovery_required,
            detail: detail.into(),
        }),
    )
        .into_response()
}

fn order_failure(err: OrderError, client_order_id: Option<Uuid>) -> Response {
    let (status, state, recovery_required) = match &err {
        OrderError::LiveForbidden | OrderError::Invalid(_) | OrderError::RiskLimit => {
            (StatusCode::UNPROCESSABLE_ENTITY, "rejected", false)
        }
        OrderError::Disabled | OrderError::MissingAdapter => {
            (StatusCode::SERVICE_UNAVAILABLE, "blocked", false)
        }
        OrderError::Expired | OrderError::NotOwner => (StatusCode::NOT_FOUND, "blocked", false),
        OrderError::Rejected => (StatusCode::UNPROCESSABLE_ENTITY, "rejected", false),
        OrderError::UnknownState => (StatusCode::BAD_GATEWAY, "unknown", true),
    };
    order_outcome_error(
        status,
        state,
        client_order_id,
        recovery_required,
        err.to_string(),
    )
}

fn disabled_execution_capabilities() -> Value {
    json!({
        "alpaca":{"paper":{"enabled":false,"implementation":"disabled"},"live":{"enabled":false,"implementation":"disabled"}},
        "ibkr":{"paper":{"enabled":false,"implementation":"disabled"},"live":{"enabled":false,"implementation":"disabled"}},
        "schwab":{"paper":{"enabled":false,"implementation":"disabled"},"live":{"enabled":false,"implementation":"disabled"}}
    })
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

fn option_subscription_union(leases: &OptionConsumerLeases) -> Vec<String> {
    let mut combined: Vec<String> = leases
        .values()
        .flat_map(|lease| lease.symbols.iter().cloned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    combined.sort();
    combined
}

fn advance_option_revision(
    sender: &watch::Sender<OptionSubscriptionRevision>,
    symbols: Vec<String>,
) -> bool {
    let current = sender.borrow().clone();
    if current.symbols == symbols {
        return true;
    }
    let Some(revision) = current.revision.checked_add(1) else {
        return false;
    };
    sender.send_replace(OptionSubscriptionRevision { revision, symbols });
    true
}

fn effective_option_subscription_limit(configured: usize) -> usize {
    configured.clamp(1, 1000).min(MAX_BROKER_OPTION_SYMBOLS)
}

fn authenticate_delegation(
    token: &str,
    keys: &AuthKeyring,
    now: usize,
) -> Result<GatewayPrincipal, ()> {
    let header = decode_header(token).map_err(|_| ())?;
    if header.alg != Algorithm::HS256 {
        return Err(());
    }
    let key_id = header.kid.as_deref().ok_or(())?;
    let (key, expected_issuer) = match key_id {
        "bff" => (keys.bff.as_deref().ok_or(())?, BFF_ISSUER),
        "research" => (keys.research.as_deref().ok_or(())?, RESEARCH_ISSUER),
        _ => return Err(()),
    };
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 5;
    validation.validate_nbf = true;
    validation.set_issuer(&[expected_issuer]);
    validation.set_audience(&[GATEWAY_AUDIENCE]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    let data = decode::<DelegationClaims>(token, &DecodingKey::from_secret(key), &validation)
        .map_err(|_| ())?;
    let claims = data.claims;
    if claims.iss != expected_issuer
        || claims.aud != GATEWAY_AUDIENCE
        || claims.sub.trim().is_empty()
        || claims.idp_iss.trim().is_empty()
        || claims.jti.trim().is_empty()
        || claims.iat > now.saturating_add(5)
        || claims.exp <= claims.iat
        || claims.exp.saturating_sub(claims.iat) > 65
        || !claims.scope.iter().all(|scope| valid_scope(scope))
        || claims.scope.is_empty()
    {
        return Err(());
    }
    if key_id == "research" && (claims.scope.len() != 1 || claims.scope[0] != "market:read") {
        return Err(());
    }
    Ok(GatewayPrincipal {
        subject: claims.sub,
        identity_issuer: claims.idp_iss,
        scopes: claims.scope.into_iter().collect(),
    })
}

fn valid_scope(scope: &str) -> bool {
    matches!(
        scope,
        "market:read"
            | "market:stream"
            | "market:subscribe"
            | "research:read"
            | "research:ai"
            | "workspace:read"
            | "workspace:write"
            | "orders:preview"
            | "paper:submit"
    )
}

async fn require_auth(
    State(keys): State<Arc<AuthKeyring>>,
    mut request: Request,
    next: Next,
) -> Response {
    if !keys.ready() {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "identity_unavailable",
            "gateway identity validation is not configured",
        );
    }
    let provided = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let Some(token) = provided else {
        return fail(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "verified user delegation required",
        );
    };
    let now = Utc::now().timestamp().max(0) as usize;
    let principal = match authenticate_delegation(token, &keys, now) {
        Ok(principal) => principal,
        Err(()) => {
            return fail(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "verified user delegation required",
            );
        }
    };
    request.extensions_mut().insert(principal);
    next.run(request).await
}

fn require_scope(principal: &GatewayPrincipal, scope: &'static str) -> Option<Response> {
    if principal.has_scope(scope) {
        None
    } else {
        Some(fail(
            StatusCode::FORBIDDEN,
            "forbidden",
            "action is not authorized",
        ))
    }
}

async fn healthz() -> impl IntoResponse {
    Json(json!({"status":"ok","service":"eqo-gateway"}))
}
async fn readyz(State(state): State<AppState>) -> Response {
    let ready = state.auth_keys.ready();
    let market_data_configured = state.data.is_some();
    let body = json!({
        "ready":ready,
        "identity_validation_configured":ready,
        "market_credentials_present":market_data_configured,
        "market_data_configured":market_data_configured,
        "market_data_ready":false,
        "market_data_status":if market_data_configured {"awaiting_upstream"} else {"not_configured"},
        "market_data_provider":"alpaca",
        "execution_mode":"disabled",
        "execution_enabled":false
    });
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(body),
    )
        .into_response()
}
async fn status(
    Extension(principal): Extension<GatewayPrincipal>,
    State(state): State<AppState>,
) -> Response {
    if let Some(response) = require_scope(&principal, "market:read") {
        return response;
    }
    Json(json!({
        "service":"EqoBoard", "schema_version":1,
        "market_credentials_present":state.data.is_some(),
        "market_data_configured":state.data.is_some(),
        "market_data_ready":false,
        "market_data_status":if state.data.is_some() {"awaiting_upstream"} else {"not_configured"},
        "stock_feed":state.stock_feed,"option_feed":state.option_feed,
        "market_data_provider":"alpaca",
        "requested_execution_mode":state.requested_execution_mode,
        "execution_mode":"disabled",
        "execution_enabled":false,
        "broker_capabilities":disabled_execution_capabilities(),
        "adapter_endpoints_configured":state.brokers.configured(),
        "max_stock_subscriptions":state.max_stock_subscriptions,
        "active_stock_subscriptions":state.stock_tx.borrow().len(),
        "max_option_subscriptions":state.max_option_subscriptions,
        "active_option_subscriptions":state.option_tx.borrow().symbols.len(),
        "stock_symbols":state.stock_symbols,
        "as_of":Utc::now().to_rfc3339(),
        "notes":"configured feeds do not imply entitlements; upstream 403 remains explicit"
    }))
    .into_response()
}

#[derive(Deserialize)]
struct SymbolsQuery {
    symbols: Option<String>,
}
async fn stock_snapshots(
    Extension(principal): Extension<GatewayPrincipal>,
    State(state): State<AppState>,
    Query(query): Query<SymbolsQuery>,
) -> Response {
    if let Some(response) = require_scope(&principal, "market:read") {
        return response;
    }
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
async fn stock_bars(
    Extension(principal): Extension<GatewayPrincipal>,
    State(state): State<AppState>,
    Query(query): Query<BarsQuery>,
) -> Response {
    if let Some(response) = require_scope(&principal, "market:read") {
        return response;
    }
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
async fn option_chain(
    Extension(principal): Extension<GatewayPrincipal>,
    State(state): State<AppState>,
    Query(query): Query<ChainQuery>,
) -> Response {
    if let Some(response) = require_scope(&principal, "market:read") {
        return response;
    }
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
    Extension(principal): Extension<GatewayPrincipal>,
    State(state): State<AppState>,
    Query(query): Query<SymbolsQuery>,
) -> Response {
    if let Some(response) = require_scope(&principal, "market:read") {
        return response;
    }
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
        Ok(rows) => Json(json!(openbb::stock_rows(
            &symbols,
            rows,
            data.source_mode(),
            &data.stock_feed
        )))
        .into_response(),
        Err(err) => data_failure(err),
    }
}

/// The IV and Greeks are snapshots, not synchronized executable combo prices.
async fn openbb_options(
    Extension(principal): Extension<GatewayPrincipal>,
    State(state): State<AppState>,
    Query(query): Query<ChainQuery>,
) -> Response {
    if let Some(response) = require_scope(&principal, "market:read") {
        return response;
    }
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
            if page.truncated && page.contracts.is_empty() {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(openbb::empty_truncated_page_error(
                        data.source_mode(),
                        &data.option_feed,
                        page.pages_fetched,
                        page.has_more,
                    )),
                )
                    .into_response();
            }
            Json(json!(openbb::option_rows(
                page,
                data.source_mode(),
                &data.option_feed
            )))
            .into_response()
        }
        Err(err) => data_failure(err),
    }
}
async fn openbb_bars(
    Extension(principal): Extension<GatewayPrincipal>,
    State(state): State<AppState>,
    Query(query): Query<BarsQuery>,
) -> Response {
    if let Some(response) = require_scope(&principal, "market:read") {
        return response;
    }
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
    match data.stock_bars_page(&symbol, &timeframe, limit, days).await {
        Ok(page) => {
            if page.truncated && page.bars.is_empty() {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(openbb::empty_truncated_page_error(
                        data.source_mode(),
                        &data.stock_feed,
                        page.pages_fetched,
                        page.has_more,
                    )),
                )
                    .into_response();
            }
            Json(json!(openbb::bar_rows(
                &symbol,
                page,
                data.source_mode(),
                &data.stock_feed
            )))
            .into_response()
        }
        Err(err) => data_failure(err),
    }
}

#[derive(Deserialize)]
struct SubscribeSymbols {
    consumer_id: Uuid,
    symbols: Vec<String>,
}

#[derive(Deserialize)]
struct OptionSubscribeSymbols {
    consumer_id: Uuid,
    generation: u64,
    symbols: Vec<String>,
}
async fn stock_subscribe(
    Extension(principal): Extension<GatewayPrincipal>,
    State(state): State<AppState>,
    Json(body): Json<SubscribeSymbols>,
) -> Response {
    if let Some(response) = require_scope(&principal, "market:subscribe") {
        return response;
    }
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
            return fail(
                StatusCode::BAD_REQUEST,
                "invalid_symbol",
                "invalid stock symbol",
            );
        }
        wanted.insert(normalized);
    }
    let mut leases = state.stock_leases.lock().await;
    leases.retain(|_, (until, _)| *until > Instant::now());
    let consumer_key = (
        principal.identity_issuer,
        principal.subject,
        body.consumer_id,
    );
    leases.insert(
        consumer_key.clone(),
        (Instant::now() + Duration::from_secs(90), wanted),
    );
    let sorted = stock_subscription_union(&state.stock_symbols, &leases);
    if sorted.len() > state.max_stock_subscriptions {
        leases.remove(&consumer_key);
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
    Extension(principal): Extension<GatewayPrincipal>,
    State(state): State<AppState>,
    Json(body): Json<OptionSubscribeSymbols>,
) -> Response {
    if let Some(response) = require_scope(&principal, "market:subscribe") {
        return response;
    }
    if body.generation == 0 {
        return fail(
            StatusCode::BAD_REQUEST,
            "invalid_generation",
            "option subscription generation must be positive",
        );
    }
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
    let before_expiry = option_subscription_union(&leases);
    leases.retain(|_, lease| lease.expires_at > Instant::now());
    let after_expiry = option_subscription_union(&leases);
    if before_expiry != after_expiry && !advance_option_revision(&state.option_tx, after_expiry) {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "subscription_state_exhausted",
            "option subscription revision exhausted",
        );
    }
    let consumer_key = (
        principal.identity_issuer,
        principal.subject,
        body.consumer_id,
    );
    if let Some(previous) = leases.get(&consumer_key) {
        if body.generation < previous.generation {
            return fail(
                StatusCode::CONFLICT,
                "stale_subscription_generation",
                "option subscription generation is stale",
            );
        }
        if body.generation == previous.generation && wanted != previous.symbols {
            return fail(
                StatusCode::CONFLICT,
                "subscription_generation_conflict",
                "one option subscription generation cannot describe multiple symbol sets",
            );
        }
    }
    let before_update = option_subscription_union(&leases);
    let previous = leases.insert(
        consumer_key.clone(),
        OptionLease {
            expires_at: Instant::now() + Duration::from_secs(90),
            generation: body.generation,
            symbols: wanted,
        },
    );
    let sorted = option_subscription_union(&leases);
    if sorted.len() > state.max_option_subscriptions {
        if let Some(previous) = previous {
            leases.insert(consumer_key, previous);
        } else {
            leases.remove(&consumer_key);
        }
        return fail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "subscription_limit",
            "global OPRA stream capacity exceeded",
        );
    }
    if before_update != sorted && !advance_option_revision(&state.option_tx, sorted.clone()) {
        if let Some(previous) = previous {
            leases.insert(consumer_key, previous);
        } else {
            leases.remove(&consumer_key);
        }
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "subscription_state_exhausted",
            "option subscription revision exhausted",
        );
    }
    Json(
        json!({"active":sorted.len(),"max":state.max_option_subscriptions,
        "expires_in_seconds":90,"generation":body.generation,"state":"lease_active"}),
    )
    .into_response()
}

async fn prune_leases(state: AppState) {
    let mut timer = tokio::time::interval(Duration::from_secs(30));
    loop {
        timer.tick().await;

        {
            let mut leases = state.option_leases.lock().await;
            let before = option_subscription_union(&leases);
            leases.retain(|_, lease| lease.expires_at > Instant::now());
            let after = option_subscription_union(&leases);
            if before != after && !advance_option_revision(&state.option_tx, after) {
                warn!("option subscription revision exhausted; retaining previous upstream state");
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

async fn create_ticket(
    Extension(principal): Extension<GatewayPrincipal>,
    State(state): State<AppState>,
) -> Response {
    if let Some(response) = require_scope(&principal, "market:stream") {
        return response;
    }
    let mut tickets = state.tickets.lock().await;
    tickets.retain(|_, (end, _, _)| *end > Instant::now());
    if tickets.len() >= 1000 {
        return fail(
            StatusCode::TOO_MANY_REQUESTS,
            "ticket_limit",
            "too many active tickets",
        );
    }
    let ticket = Uuid::new_v4();
    tickets.insert(
        ticket,
        (
            Instant::now() + Duration::from_secs(15),
            principal.identity_issuer.clone(),
            principal.subject.clone(),
        ),
    );
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
        .is_some_and(|(expires, issuer, subject)| {
            expires > Instant::now() && !issuer.trim().is_empty() && !subject.trim().is_empty()
        });
    if !valid {
        return fail(StatusCode::UNAUTHORIZED, "ticket", "expired/used WS ticket");
    }
    let publisher = state.market_publisher.clone();
    let (receiver, initial_status) = publisher.subscribe_with_snapshot();
    upgrade
        .on_upgrade(move |ws| stream_to_browser(ws, receiver, publisher, initial_status))
        .into_response()
}

async fn stream_to_browser(
    mut ws: WebSocket,
    mut rx: broadcast::Receiver<GatewayMarketEvent>,
    publisher: MarketPublisher,
    mut batch: Vec<GatewayMarketEvent>,
) {
    let mut discard_through_sequence = 0;
    let mut flush = tokio::time::interval(Duration::from_millis(50));
    batch.reserve(256usize.saturating_sub(batch.len()));
    loop {
        tokio::select! {
            received = rx.recv() => match received {
                Ok(event) => append_market_event_or_resync(
                    &publisher,
                    &mut batch,
                    &mut discard_through_sequence,
                    event,
                ),
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    discard_through_sequence = discard_through_sequence.max(
                        replace_batch_with_resync_statuses(&publisher, &mut batch),
                    );
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

const MARKET_EVENT_BATCH_CAP: usize = 512;

/// Replace an overflowing batch with fresh feed snapshots and return their sequence watermark.
/// 溢出时只保留新的 feed 快照并返回序号水位，避免把旧触发事件排在快照之后。
fn replace_batch_with_resync_statuses(
    publisher: &MarketPublisher,
    batch: &mut Vec<GatewayMarketEvent>,
) -> u64 {
    batch.clear();
    batch.extend(publisher.resync_events());
    batch
        .iter()
        .map(GatewayMarketEvent::local_sequence)
        .max()
        .unwrap_or(0)
}

/// Queue only events newer than the latest resync snapshot; the triggering overflow event is discarded.
/// 只排入晚于最近 resync 快照的事件；触发溢出的旧事件会被丢弃。
fn append_market_event_or_resync(
    publisher: &MarketPublisher,
    batch: &mut Vec<GatewayMarketEvent>,
    discard_through_sequence: &mut u64,
    event: GatewayMarketEvent,
) {
    if event.local_sequence() <= *discard_through_sequence {
        return;
    }
    if batch.len() >= MARKET_EVENT_BATCH_CAP {
        *discard_through_sequence =
            (*discard_through_sequence).max(replace_batch_with_resync_statuses(publisher, batch));
        return;
    }
    batch.push(event);
}

/// Same normalized market broadcast used by the existing WebSocket terminal.
/// Next.js serves it to the OpenTerminal browser with credentials kept server-side.
async fn live_sse(
    Extension(principal): Extension<GatewayPrincipal>,
    State(state): State<AppState>,
) -> Response {
    if let Some(response) = require_scope(&principal, "market:stream") {
        return response;
    }
    let mut timer = tokio::time::interval(Duration::from_millis(50));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let publisher = state.market_publisher.clone();
    let (receiver, initial_status) = publisher.subscribe_with_snapshot();
    let events = stream::unfold(
        (
            receiver,
            initial_status,
            Vec::<GatewayMarketEvent>::new(),
            timer,
            publisher,
            0_u64,
        ),
        |(
            mut rx,
            mut initial_status,
            mut batch,
            mut flush,
            publisher,
            mut discard_through_sequence,
        )| async move {
            if !initial_status.is_empty() {
                batch.append(&mut initial_status);
            }
            loop {
                tokio::select! {
                    event = rx.recv() => match event {
                        Ok(event) => append_market_event_or_resync(
                            &publisher,
                            &mut batch,
                            &mut discard_through_sequence,
                            event,
                        ),
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            discard_through_sequence = discard_through_sequence.max(
                                replace_batch_with_resync_statuses(&publisher, &mut batch),
                            );
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
            Some((
                Ok::<Event, Infallible>(Event::default().data(json)),
                (
                    rx,
                    Vec::new(),
                    Vec::new(),
                    flush,
                    publisher,
                    discard_through_sequence,
                ),
            ))
        },
    );
    Sse::new(events)
        .keep_alive(KeepAlive::default())
        .into_response()
}

#[derive(Deserialize)]
struct SubmitPreview {
    preview_id: Uuid,
    confirm: bool,
}

async fn order_preview(
    Extension(principal): Extension<GatewayPrincipal>,
    State(state): State<AppState>,
    Json(order): Json<OrderIntent>,
) -> Response {
    if let Some(response) = require_scope(&principal, "orders:preview") {
        return response;
    }
    match state
        .previews
        .create(principal.preview_owner(), order, state.risk)
        .await
    {
        Ok(preview) => Json(json!({"preview":preview,"execution_enabled":state.execution_enabled}))
            .into_response(),
        Err(err) => order_failure(err, None),
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

async fn order_submit(
    Extension(principal): Extension<GatewayPrincipal>,
    State(state): State<AppState>,
    Json(body): Json<SubmitPreview>,
) -> Response {
    if let Some(response) = require_scope(&principal, "paper:submit") {
        return response;
    }
    if !body.confirm {
        return order_outcome_error(
            StatusCode::BAD_REQUEST,
            "rejected",
            None,
            false,
            "explicit confirm=true required",
        );
    }
    let owner = principal.preview_owner();
    if let Err(err) = state.previews.authorize(body.preview_id, &owner).await {
        return order_failure(err, None);
    }
    if !state.execution_enabled {
        return order_outcome_error(
            StatusCode::CONFLICT,
            "blocked",
            None,
            false,
            "Paper execution is disabled until persistent preview, outbox, and account-binding gates are complete.",
        );
    }
    let intent = match state.previews.consume(body.preview_id, &owner).await {
        Ok(o) => o,
        Err(err) => return order_failure(err, None),
    };
    if let Err(err) = eqo_execution::validate_order(&intent, state.risk) {
        return order_failure(err, None);
    }
    let broker = intent.broker.name();
    let id = Uuid::new_v4();
    // Fail-closed if audit cannot be durably appended.
    if let Err(err) = audit(&state, id, broker, "attempted").await {
        error!(error=%err,"audit write failed - order blocked");
        return order_outcome_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "blocked",
            Some(id),
            false,
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
            let state_name = match &err {
                OrderError::UnknownState => "unknown",
                OrderError::Rejected => "rejected",
                _ => "blocked",
            };
            if let Err(audit_err) = audit(&state, id, broker, state_name).await {
                error!(error=%audit_err,"post-submission audit failed");
            }
            // Return id so a timeout can be reconciled; never silently retry.
            order_failure(err, Some(id))
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
    let auth_keys = AuthKeyring::from_env();
    if !auth_keys.ready() {
        if !addr.ip().is_loopback() {
            return Err(
                "non-loopback bind requires verifiable gateway and research JWT keys".into(),
            );
        }
        warn!("identity signing keys unavailable or not independent; protected API and readiness remain fail-closed");
    }
    let mode = std::env::var("EQO_EXECUTION_MODE").unwrap_or_else(|_| "disabled".into());
    if !["disabled", "paper", "live"].contains(&mode.as_str()) {
        return Err("EQO_EXECUTION_MODE must be disabled, paper, or live".into());
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
    let (option_tx, option_rx) = watch::channel(OptionSubscriptionRevision::default());
    let max_stock_subscriptions = std::env::var("EQO_MAX_STOCK_SUBSCRIPTIONS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(100)
        .max(stocks.len())
        .min(1000);
    let max_option_subscriptions = effective_option_subscription_limit(
        std::env::var("EQO_MAX_OPTION_SUBSCRIPTIONS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(500),
    );
    let (broadcasts, _) = broadcast::channel::<GatewayMarketEvent>(4096);
    let market_publisher = MarketPublisher::new(broadcasts);
    let option_port_enabled = data.as_ref().is_some_and(|configured| {
        configured.source_mode() == "alpaca"
            && option_feed == "opra"
            && std::env::var_os("EQO_MARKET_STREAM_BASE_URL").is_none()
    });
    let option_port = option_port_enabled.then(alpaca_opra_port);
    let risk = RiskPolicy::from_env();
    let state = AppState {
        data: data.clone(),
        stock_feed,
        option_feed,
        requested_execution_mode: mode,
        execution_enabled: false,
        auth_keys: auth_keys.clone(),
        stock_symbols: stocks,
        max_stock_subscriptions,
        stock_tx: stock_tx.clone(),
        stock_leases: Arc::default(),
        max_option_subscriptions,
        option_tx,
        option_leases: Arc::default(),
        market_publisher: market_publisher.clone(),
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
        let (legacy_stock_tx, _) = broadcast::channel(4096);
        let legacy_stock_receiver = legacy_stock_tx.subscribe();
        let legacy_stock_sender = legacy_stock_tx.clone();
        let quotes = data;
        tokio::spawn(async move { quotes.stream(false, stock_rx, legacy_stock_sender).await });
        tokio::spawn(market_stream::bridge_legacy_stock_stream(
            legacy_stock_receiver,
            stock_tx.subscribe(),
            market_publisher.clone(),
            max_stock_subscriptions,
        ));
    } else {
        warn!("missing market data credentials; API returns 503, no fake prices");
    }
    if !option_port_enabled {
        warn!("OPRA Broker port unavailable for this configuration; option ACK and source remain unknown");
    }
    tokio::spawn(run_option_market_stream(
        option_port,
        option_rx,
        market_publisher,
        max_option_subscriptions,
    ));
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
        .route_layer(middleware::from_fn_with_state(
            Arc::new(auth_keys.clone()),
            require_auth,
        ));
    let web_dist = std::env::var("EQO_WEB_DIST").unwrap_or_else(|_| "./apps/gateway/empty".into());
    let openbb_api = Router::new()
        .route("/openbb/v1/stocks", get(openbb_stocks))
        .route("/openbb/v1/options", get(openbb_options))
        .route("/openbb/v1/bars", get(openbb_bars))
        .route_layer(middleware::from_fn_with_state(
            Arc::new(auth_keys),
            require_auth,
        ));
    let mut app = Router::new()
        .route("/widgets.json", get(openbb_widgets))
        .route("/apps.json", get(openbb_apps))
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
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
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde::Serialize;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

    #[derive(Serialize)]
    struct TestClaims<'a> {
        sub: &'a str,
        iss: &'a str,
        aud: &'a str,
        iat: usize,
        exp: usize,
        jti: &'a str,
        idp_iss: &'a str,
        scope: Vec<&'a str>,
    }

    fn test_token(secret: &[u8], kid: &str, issuer: &str, scope: Vec<&str>) -> String {
        test_token_for(
            secret,
            kid,
            issuer,
            scope,
            "subject-1",
            "https://identity.example",
        )
    }

    fn test_token_for(
        secret: &[u8],
        kid: &str,
        issuer: &str,
        scope: Vec<&str>,
        subject: &str,
        identity_issuer: &str,
    ) -> String {
        let now = Utc::now().timestamp().max(0) as usize;
        let mut header = Header::new(Algorithm::HS256);
        header.kid = Some(kid.to_owned());
        encode(
            &header,
            &TestClaims {
                sub: subject,
                iss: issuer,
                aud: GATEWAY_AUDIENCE,
                iat: now,
                exp: now + 60,
                jti: "test-token-id",
                idp_iss: identity_issuer,
                scope,
            },
            &EncodingKey::from_secret(secret),
        )
        .expect("test token encodes")
    }

    fn test_token_with_malformed_nbf(secret: &[u8], kid: &str, issuer: &str, nbf: &str) -> String {
        let now = Utc::now().timestamp().max(0) as usize;
        let mut header = Header::new(Algorithm::HS256);
        header.kid = Some(kid.to_owned());
        let claims = serde_json::json!({
            "sub": "subject-1",
            "iss": issuer,
            "aud": GATEWAY_AUDIENCE,
            "iat": now,
            "exp": now + 60,
            "jti": "malformed-nbf-test-token",
            "idp_iss": "https://identity.example",
            "scope": ["market:read"],
            "nbf": nbf,
        });
        encode(&header, &claims, &EncodingKey::from_secret(secret)).expect("test token encodes")
    }

    fn order_test_state(brokers: BrokerRouter, keys: AuthKeyring) -> AppState {
        let (stock_tx, _) = watch::channel(Vec::<String>::new());
        let (option_tx, _) = watch::channel(OptionSubscriptionRevision::default());
        let (broadcasts, _) = broadcast::channel::<GatewayMarketEvent>(16);
        AppState {
            data: None,
            stock_feed: "sip".into(),
            option_feed: "opra".into(),
            requested_execution_mode: "paper".into(),
            execution_enabled: false,
            auth_keys: keys,
            stock_symbols: Vec::new(),
            max_stock_subscriptions: 100,
            stock_tx,
            stock_leases: Arc::default(),
            max_option_subscriptions: MAX_BROKER_OPTION_SYMBOLS,
            option_tx,
            option_leases: Arc::default(),
            market_publisher: MarketPublisher::new(broadcasts),
            tickets: Arc::default(),
            previews: PreviewStore::default(),
            risk: RiskPolicy {
                max_qty: 10,
                max_loss: 1_000.0,
            },
            brokers,
            audit_path: std::env::temp_dir()
                .join(format!(
                    "eqoboard-gateway-order-test-{}.jsonl",
                    Uuid::new_v4()
                ))
                .to_string_lossy()
                .into_owned(),
            audit_lock: Arc::default(),
            chains: Arc::default(),
        }
    }

    fn order_test_app(state: AppState, keys: AuthKeyring) -> Router {
        Router::new()
            .route("/api/v1/orders/preview", post(order_preview))
            .route("/api/v1/orders/submit", post(order_submit))
            .route("/api/v1/status", get(status))
            .route_layer(middleware::from_fn_with_state(Arc::new(keys), require_auth))
            .with_state(state)
    }

    async fn post_json(app: &Router, path: &str, token: &str, body: Value) -> (StatusCode, Value) {
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::POST)
                    .uri(path)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(axum::body::Body::from(body.to_string()))
                    .expect("test request builds"),
            )
            .await
            .expect("test router responds");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1_048_576)
            .await
            .expect("test response body reads");
        let body = serde_json::from_slice(&bytes).expect("response is JSON");
        (status, body)
    }

    async fn get_json(app: &Router, path: &str, token: &str) -> (StatusCode, Value) {
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::GET)
                    .uri(path)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(axum::body::Body::empty())
                    .expect("test request builds"),
            )
            .await
            .expect("test router responds");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1_048_576)
            .await
            .expect("test response body reads");
        let body = serde_json::from_slice(&bytes).expect("response is JSON");
        (status, body)
    }

    #[derive(Clone, Copy)]
    enum MockAdapterResult {
        Accepted,
        InvalidAck,
    }

    struct CountingAdapter {
        calls: Arc<AtomicUsize>,
        result: MockAdapterResult,
    }

    #[async_trait::async_trait]
    impl eqo_execution::BrokerAdapter for CountingAdapter {
        async fn submit(
            &self,
            id: Uuid,
            _intent: &OrderIntent,
        ) -> Result<eqo_execution::AdapterAck, OrderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match self.result {
                MockAdapterResult::Accepted => Ok(eqo_execution::AdapterAck {
                    client_order_id: id.to_string(),
                    status: "accepted".into(),
                    broker_order_id: None,
                    as_of: None,
                }),
                MockAdapterResult::InvalidAck => Ok(eqo_execution::AdapterAck {
                    client_order_id: id.to_string(),
                    status: "working".into(),
                    broker_order_id: Some("broker-order-1".into()),
                    as_of: None,
                }),
            }
        }
    }

    fn valid_preview_intent() -> OrderIntent {
        let expiration = Utc::now().date_naive() + chrono::Duration::days(30);
        let expiration = expiration.format("%y%m%d");
        OrderIntent {
            broker: eqo_execution::Broker::Ibkr,
            environment: eqo_execution::Environment::Paper,
            kind: eqo_execution::OrderKind::Vertical,
            symbol: None,
            quantity: 1,
            limit_price: 0.01,
            net_effect: eqo_execution::NetEffect::Debit,
            legs: vec![
                eqo_execution::OrderLeg {
                    symbol: format!("QQQ{expiration}P00620000"),
                    side: eqo_execution::Side::Buy,
                },
                eqo_execution::OrderLeg {
                    symbol: format!("QQQ{expiration}P00600000"),
                    side: eqo_execution::Side::Sell,
                },
            ],
        }
    }

    #[tokio::test]
    async fn order_preview_is_identity_bound_and_paper_submit_never_reaches_adapter() {
        let bff_secret = vec![b'b'; 64];
        let research_secret = vec![b'r'; 64];
        let keys = AuthKeyring {
            bff: Some(Arc::new(bff_secret.clone())),
            research: Some(Arc::new(research_secret)),
        };
        let adapter_calls = Arc::new(AtomicUsize::new(0));
        let brokers = BrokerRouter::from_adapters(HashMap::from([(
            eqo_execution::Broker::Ibkr,
            Arc::new(CountingAdapter {
                calls: adapter_calls.clone(),
                result: MockAdapterResult::Accepted,
            }) as Arc<dyn eqo_execution::BrokerAdapter>,
        )]));
        let app = order_test_app(order_test_state(brokers, keys.clone()), keys);
        let owner_a = test_token_for(
            &bff_secret,
            "bff",
            BFF_ISSUER,
            vec!["orders:preview", "paper:submit", "market:read"],
            "same-subject",
            "https://identity-a.example",
        );
        let owner_b_same_subject = test_token_for(
            &bff_secret,
            "bff",
            BFF_ISSUER,
            vec!["paper:submit"],
            "same-subject",
            "https://identity-b.example",
        );

        let requested = valid_preview_intent();
        let requested_json = serde_json::to_value(&requested).unwrap();
        let (preview_status, preview_response) = post_json(
            &app,
            "/api/v1/orders/preview",
            &owner_a,
            requested_json.clone(),
        )
        .await;
        assert_eq!(preview_status, StatusCode::OK);
        assert_eq!(preview_response["execution_enabled"], false);
        let preview = &preview_response["preview"];
        assert_eq!(preview["intent"], requested_json);
        assert_eq!(preview["estimated_max_loss"], 1.0);
        assert_eq!(preview["currency"], "USD");
        let preview_id = preview["preview_id"].as_str().expect("preview id");

        let (other_issuer_status, other_issuer_response) = post_json(
            &app,
            "/api/v1/orders/submit",
            &owner_b_same_subject,
            json!({"preview_id":preview_id,"confirm":true}),
        )
        .await;
        assert_eq!(other_issuer_status, StatusCode::NOT_FOUND);
        assert_eq!(other_issuer_response["state"], "blocked");
        assert_eq!(other_issuer_response["retryable"], false);
        assert_eq!(other_issuer_response["recovery_required"], false);
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 0);

        let (owner_submit_status, owner_submit_response) = post_json(
            &app,
            "/api/v1/orders/submit",
            &owner_a,
            json!({"preview_id":preview_id,"confirm":true}),
        )
        .await;
        assert_eq!(owner_submit_status, StatusCode::CONFLICT);
        assert_eq!(owner_submit_response["state"], "blocked");
        assert_eq!(owner_submit_response["retryable"], false);
        assert!(owner_submit_response["detail"]
            .as_str()
            .unwrap()
            .contains("Paper execution is disabled"));
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 0);

        let (status_code, status_response) = get_json(&app, "/api/v1/status", &owner_a).await;
        assert_eq!(status_code, StatusCode::OK);
        assert_eq!(status_response["execution_enabled"], false);
        assert_eq!(
            status_response["broker_capabilities"]["schwab"]["paper"]["enabled"],
            false
        );
        assert_eq!(
            status_response["broker_capabilities"]["schwab"]["paper"]["implementation"],
            "disabled"
        );
        assert_eq!(
            status_response["adapter_endpoints_configured"],
            json!(["ibkr"])
        );
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn invalid_adapter_ack_keeps_client_order_id_and_recovery_contract() {
        let bff_secret = vec![b'b'; 64];
        let keys = AuthKeyring {
            bff: Some(Arc::new(bff_secret.clone())),
            research: Some(Arc::new(vec![b'r'; 64])),
        };
        let adapter_calls = Arc::new(AtomicUsize::new(0));
        let brokers = BrokerRouter::from_adapters(HashMap::from([(
            eqo_execution::Broker::Ibkr,
            Arc::new(CountingAdapter {
                calls: adapter_calls.clone(),
                result: MockAdapterResult::InvalidAck,
            }) as Arc<dyn eqo_execution::BrokerAdapter>,
        )]));
        let mut state = order_test_state(brokers, keys.clone());
        // Test the otherwise unreachable dispatch branch with an in-memory adapter only.
        // Production startup hard-codes this gate to false until persistence and account binding exist.
        state.execution_enabled = true;
        let audit_path = state.audit_path.clone();
        let app = order_test_app(state, keys);
        let owner = test_token_for(
            &bff_secret,
            "bff",
            BFF_ISSUER,
            vec!["orders:preview", "paper:submit"],
            "operator-1",
            "https://identity.example",
        );
        let (preview_status, preview_response) = post_json(
            &app,
            "/api/v1/orders/preview",
            &owner,
            serde_json::to_value(valid_preview_intent()).unwrap(),
        )
        .await;
        assert_eq!(preview_status, StatusCode::OK);
        let preview_id = preview_response["preview"]["preview_id"]
            .as_str()
            .expect("preview id");

        let (submit_status, submit_response) = post_json(
            &app,
            "/api/v1/orders/submit",
            &owner,
            json!({"preview_id":preview_id,"confirm":true}),
        )
        .await;
        assert_eq!(submit_status, StatusCode::BAD_GATEWAY);
        assert_eq!(submit_response["state"], "unknown");
        assert_eq!(submit_response["retryable"], false);
        assert_eq!(submit_response["recovery_required"], true);
        assert!(submit_response["client_order_id"].as_str().is_some());
        assert!(submit_response["detail"]
            .as_str()
            .unwrap()
            .contains("reconcile by client_order_id"));
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 1);
        let _ = tokio::fs::remove_file(audit_path).await;
    }

    async fn protected_call_count(keys: AuthKeyring, token: Option<&str>) -> (StatusCode, usize) {
        async fn protected(
            Extension(principal): Extension<GatewayPrincipal>,
            State(calls): State<Arc<AtomicUsize>>,
        ) -> Response {
            if let Some(response) = require_scope(&principal, "orders:preview") {
                return response;
            }
            calls.fetch_add(1, Ordering::SeqCst);
            StatusCode::NO_CONTENT.into_response()
        }

        let calls = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/protected", get(protected))
            .route_layer(middleware::from_fn_with_state(Arc::new(keys), require_auth))
            .with_state(calls.clone());
        let mut request = axum::http::Request::builder()
            .uri("/protected")
            .header("x-user", "attacker")
            .header("x-role", "eqoboard-paper-operator");
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = app
            .oneshot(request.body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        (response.status(), calls.load(Ordering::SeqCst))
    }

    #[test]
    fn subscription_unions_are_sorted_and_deduplicated() {
        let now = Instant::now() + Duration::from_secs(60);
        let mut leases = ConsumerLeases::new();
        leases.insert(
            (
                "https://issuer.example".into(),
                "user-1".into(),
                Uuid::nil(),
            ),
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
        let mut option_leases = OptionConsumerLeases::new();
        option_leases.insert(
            (
                "https://issuer.example".into(),
                "user-1".into(),
                Uuid::nil(),
            ),
            OptionLease {
                expires_at: now,
                generation: 1,
                symbols: ["QQQ".to_string(), "NVDA".to_string()]
                    .into_iter()
                    .collect(),
            },
        );
        assert_eq!(
            option_subscription_union(&option_leases),
            vec!["NVDA".to_string(), "QQQ".to_string()]
        );
    }
    #[test]
    fn symbols_validated() {
        assert!(safe_symbol("SPY"));
        assert!(safe_symbol("BRK.B"));
        assert!(!safe_symbol("SPY/../../secrets"));
    }

    #[test]
    fn key_id_and_issuer_select_separate_delegation_keys_and_scopes() {
        let bff = b"bff-signing-secret-that-is-at-least-64-bytes-long-0123456789abcdef";
        let research = b"research-signing-secret-that-is-at-least-64-bytes-long-0123456789";
        let keys = AuthKeyring {
            bff: Some(Arc::new(bff.to_vec())),
            research: Some(Arc::new(research.to_vec())),
        };

        assert!(authenticate_delegation(
            &test_token(bff, "bff", BFF_ISSUER, vec!["orders:preview"]),
            &keys,
            Utc::now().timestamp().max(0) as usize,
        )
        .is_ok());
        assert!(authenticate_delegation(
            &test_token(research, "research", RESEARCH_ISSUER, vec!["market:read"]),
            &keys,
            Utc::now().timestamp().max(0) as usize,
        )
        .is_ok());

        // A process with only the Node research key cannot claim the BFF kid/issuer.
        assert!(authenticate_delegation(
            &test_token(research, "bff", BFF_ISSUER, vec!["orders:preview"]),
            &keys,
            Utc::now().timestamp().max(0) as usize,
        )
        .is_err());
        assert!(authenticate_delegation(
            &test_token(research, "research", RESEARCH_ISSUER, vec!["paper:submit"]),
            &keys,
            Utc::now().timestamp().max(0) as usize,
        )
        .is_err());
    }

    #[test]
    fn malformed_future_nbf_is_rejected_even_when_not_required() {
        let research = b"research-signing-secret-that-is-at-least-64-bytes-long-0123456789";
        let keys = AuthKeyring {
            bff: Some(Arc::new(vec![b'b'; 64])),
            research: Some(Arc::new(research.to_vec())),
        };
        let now = Utc::now().timestamp().max(0) as usize;
        let malformed_future_nbf = now.saturating_add(3_600).to_string();
        let token = test_token_with_malformed_nbf(
            research,
            "research",
            RESEARCH_ISSUER,
            &malformed_future_nbf,
        );

        // `nbf` is intentionally absent from required_spec_claims; a malformed
        // standard claim must still fail validation rather than act as absent.
        assert!(authenticate_delegation(&token, &keys, now).is_err());
    }

    #[tokio::test]
    async fn forged_identity_headers_and_static_access_token_never_reach_handlers() {
        let keys = AuthKeyring {
            bff: Some(Arc::new(vec![b'b'; 64])),
            research: Some(Arc::new(vec![b'r'; 64])),
        };
        for token in [None, Some("static-test-access-token")] {
            let (status, downstream_calls) = protected_call_count(keys.clone(), token).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert_eq!(downstream_calls, 0);
        }
    }

    #[tokio::test]
    async fn shared_bff_and_research_signing_key_fails_closed_before_handlers() {
        let shared = Arc::new(vec![b's'; 64]);
        let keys = AuthKeyring {
            bff: Some(shared.clone()),
            research: Some(shared),
        };
        assert!(!keys.ready());
        let token = test_token(
            keys.bff.as_deref().expect("test key"),
            "bff",
            BFF_ISSUER,
            vec!["orders:preview"],
        );
        let (status, downstream_calls) = protected_call_count(keys, Some(&token)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(downstream_calls, 0);
    }

    #[tokio::test]
    async fn missing_identity_keys_fail_closed_without_stopping_liveness_process() {
        let keys = AuthKeyring::default();
        assert!(!keys.ready());
        let (status, downstream_calls) = protected_call_count(keys, None).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(downstream_calls, 0);
    }
}
