use super::*;
use jsonwebtoken::{encode, EncodingKey, Header};
use std::sync::{
    atomic::{AtomicU16, Ordering},
    Arc, Mutex as StdMutex,
};
use tokio::task::JoinHandle;
use tower::ServiceExt;

#[derive(Clone)]
struct MockUpstream {
    status: Arc<AtomicU16>,
    requests: Arc<StdMutex<Vec<String>>>,
    redirect: Option<String>,
}

struct MockServer {
    base: String,
    state: MockUpstream,
    task: JoinHandle<()>,
}

fn query_value<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    let prefix = format!("{name}=");
    query.split('&').find_map(|part| part.strip_prefix(&prefix))
}

fn empty_truncated_bars_page(query: &str) -> Value {
    let next_token = match query_value(query, "page_token") {
        None => "empty-bars-1",
        Some("empty-bars-1") => "empty-bars-2",
        Some("empty-bars-2") => "empty-bars-3",
        Some("empty-bars-3") => "empty-bars-4",
        Some("empty-bars-4") => "empty-bars-5",
        Some(_) => "unexpected-empty-bars-page",
    };
    json!({"bars": [], "next_page_token": next_token})
}

fn empty_then_bar_page(query: &str) -> Value {
    match query_value(query, "page_token") {
        None => json!({"bars": [], "next_page_token": "empty-then-bar"}),
        Some("empty-then-bar") => json!({
            "bars": [{"t":"2026-10-07T12:00:00Z","o":598.0,"h":599.0,"l":597.0,"c":598.5,"v":1200}],
            "next_page_token": null
        }),
        Some(_) => json!({"bars": [], "next_page_token": null}),
    }
}

fn empty_truncated_options_page(query: &str) -> Value {
    let next_token = match query_value(query, "page_token") {
        None => "empty-options-1",
        Some("empty-options-1") => "empty-options-2",
        Some("empty-options-2") => "empty-options-3",
        Some("empty-options-3") => "empty-options-4",
        Some("empty-options-4") => "empty-options-5",
        Some(_) => "unexpected-empty-options-page",
    };
    json!({"snapshots": {}, "next_page_token": next_token})
}

impl MockServer {
    async fn start(status: u16, redirect: Option<String>) -> Self {
        let state = MockUpstream {
            status: Arc::new(AtomicU16::new(status)),
            requests: Arc::new(StdMutex::new(Vec::new())),
            redirect,
        };
        let app = Router::new()
            .fallback(axum::routing::any(mock_upstream))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("mock listener binds");
        let address = listener.local_addr().expect("mock listener has address");
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("mock server serves");
        });
        Self {
            base: format!("http://{address}"),
            state,
            task,
        }
    }

    fn requests(&self) -> Vec<String> {
        self.state
            .requests
            .lock()
            .expect("request lock is healthy")
            .clone()
    }

    fn stop(self) {
        self.task.abort();
    }
}

async fn mock_upstream(State(state): State<MockUpstream>, request: Request) -> Response {
    let uri = request.uri().to_string();
    state
        .requests
        .lock()
        .expect("request lock is healthy")
        .push(uri.clone());
    let status = StatusCode::from_u16(state.status.load(Ordering::SeqCst))
        .expect("test response status is valid");
    if status == StatusCode::FOUND || status == StatusCode::MOVED_PERMANENTLY {
        let mut response = StatusCode::FOUND.into_response();
        if let Some(target) = &state.redirect {
            response.headers_mut().insert(
                header::LOCATION,
                target.parse().expect("test redirect location is valid"),
            );
        }
        return response;
    }
    if !status.is_success() {
        return (status, Json(json!({"error":"upstream detail is private"}))).into_response();
    }

    let path = request.uri().path();
    let query = request.uri().query().unwrap_or_default();
    let payload = match path {
        "/v2/stocks/snapshots" => json!({
            "QQQ": {
                "latestTrade": {"p": 600.25, "t": "provider-time-invalid"},
                "latestQuote": {"bp": 600.2, "ap": 600.3, "t": "2026-10-07T14:10:00Z"}
            }
        }),
        "/v2/stocks/QQQ/bars" if query.contains("page_token=bars-page-2") => json!({
            "bars": [{"t":"2026-10-07T12:00:00Z","o":598.0,"h":599.0,"l":597.0,"c":598.5,"v":1200}],
            "next_page_token": null
        }),
        "/v2/stocks/QQQ/bars" if query.contains("timeframe=1Min") && query.contains("limit=2") => {
            empty_truncated_bars_page(query)
        }
        "/v2/stocks/QQQ/bars" if query.contains("timeframe=1Week") && query.contains("limit=3") => {
            empty_then_bar_page(query)
        }
        "/v2/stocks/QQQ/bars" if query.contains("timeframe=1Hour") && query.contains("limit=4") => {
            json!({"bars": [], "next_page_token": null})
        }
        "/v2/stocks/QQQ/bars" if query.contains("timeframe=1Hour") => json!({
            "bars": [{"t":"2026-10-07T12:00:00Z","o":598.0,"h":599.0,"l":597.0,"c":598.5,"v":1200}]
        }),
        "/v2/stocks/QQQ/bars" if query.contains("timeframe=1Day") => json!({
            "bars": [{"t":"2026-10-07T12:00:00Z","o":598.0,"h":599.0,"l":597.0,"c":598.5,"v":1200}],
            "next_page_token": ""
        }),
        "/v2/stocks/QQQ/bars" if query.contains("timeframe=1Week") => json!({
            "bars": [{"t":"2026-10-07T12:00:00Z","o":598.0,"h":599.0,"l":597.0,"c":598.5,"v":1200}],
            "next_page_token": 2
        }),
        "/v2/stocks/QQQ/bars" if query.contains("timeframe=1Month") => json!({
            "bars": [{"t":"2026-10-07T12:00:00Z","o":598.0,"h":599.0,"l":597.0,"c":598.5,"v":1200}],
            "next_page_token": {"cursor":"unexpected"}
        }),
        "/v2/stocks/QQQ/bars" if query.contains("timeframe=15Min") => json!({
            "bars": [{"t":"2026-10-07T12:00:00Z","o":598.0,"h":599.0,"l":597.0,"c":598.5}],
            "next_page_token": null
        }),
        "/v2/stocks/QQQ/bars" if query.contains("timeframe=5Min") => json!({
            "bars": [{"t":"2026-10-07T12:00:00Z","o":598.0,"h":599.0,"l":597.0,"c":598.5,"v":1200}],
            "next_page_token": "repeat-page"
        }),
        "/v2/stocks/QQQ/bars" => json!({
            "bars": [
                {"t":"2026-10-07T14:00:00Z","o":600.0,"h":601.0,"l":599.0,"c":600.5,"v":2100},
                {"t":"2026-10-07T13:00:00Z","o":599.0,"h":600.0,"l":598.0,"c":599.5,"v":1800}
            ],
            "next_page_token": "bars-page-2"
        }),
        "/v1beta1/options/snapshots/QQQ" if query.contains("expiration_date=2026-10-11") => json!({
            "snapshots": {
                "NOT-OCC": {
                    "latestQuote":{"bp":1.2,"ap":1.4,"t":"2026-10-07T14:12:00Z"}
                }
            },
            "next_page_token": null
        }),
        "/v1beta1/options/snapshots/QQQ" if query.contains("expiration_date=2026-10-12") => json!({
            "snapshots": {
                "QQQ261012C00600000": {
                    "latestQuote":{"bp":1.2,"ap":1.4,"t":"2026-10-07T14:12:00Z"}
                }
            },
            "next_page_token": 2
        }),
        "/v1beta1/options/snapshots/QQQ" if query.contains("expiration_date=2026-10-13") => json!({
            "snapshots": {
                "QQQ261013C00600000": {
                    "latestQuote":{"bp":1.2,"ap":1.4,"t":"2026-10-07T14:12:00Z"}
                }
            },
            "next_page_token": {"cursor":"unexpected"}
        }),
        "/v1beta1/options/snapshots/QQQ" if query.contains("expiration_date=2026-10-14") => json!({
            "snapshots": {
                "QQQ261014C00600000": {
                    "latestQuote":{"bp":1.2,"ap":1.4,"t":"2026-10-07T14:12:00Z"}
                }
            },
            "next_page_token": ""
        }),
        "/v1beta1/options/snapshots/QQQ" if query.contains("expiration_date=2026-10-15") => json!({
            "snapshots": {
                "QQQ261016C00600000": {
                    "latestQuote":{"bp":1.2,"ap":1.4,"t":"2026-10-07T14:12:00Z"}
                }
            },
            "next_page_token": null
        }),
        "/v1beta1/options/snapshots/QQQ" if query.contains("expiration_date=2026-10-17") => {
            empty_truncated_options_page(query)
        }
        "/v1beta1/options/snapshots/QQQ" if query.contains("expiration_date=2026-10-18") => {
            json!({"snapshots": {}})
        }
        "/v1beta1/options/snapshots/QQQ" if query.contains("expiration_date=2026-10-10") => {
            truncated_option_page(query)
        }
        "/v1beta1/options/snapshots/QQQ" if query.contains("page_token=options-page-2") => json!({
            "snapshots": {
                "QQQ261009P00590000": {
                    "latestQuote":{"bp":1.1,"ap":1.3,"t":"2026-10-07T14:11:00Z"},
                    "latestTrade":{"p":1.2,"t":"2026-10-07T14:09:00Z"},
                    "impliedVolatility":0.21,
                    "greeks":{"delta":-0.3}
                }
            },
            "next_page_token": null
        }),
        "/v1beta1/options/snapshots/QQQ" => json!({
            "snapshots": {
                "QQQ261009C00600000": {
                    "latestQuote":{"bp":1.2,"ap":1.4,"t":"2026-10-07T14:12:00Z"},
                    "latestTrade":{"p":1.3,"t":"2026-10-07T14:08:00Z"},
                    "impliedVolatility":0.2,
                    "greeks":{"delta":0.5}
                }
            },
            "next_page_token": "options-page-2"
        }),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    Json(payload).into_response()
}

fn truncated_option_page(query: &str) -> Value {
    let token = query
        .split('&')
        .find_map(|part| part.strip_prefix("page_token="));
    let page = match token {
        None => 0,
        Some("option-roll-1") => 1,
        Some("option-roll-2") => 2,
        Some("option-roll-3") => 3,
        Some("option-roll-4") => 4,
        _ => 5,
    };
    let symbol = format!("QQQ261010C{:08}", 600_000 + page * 1_000);
    let next_token = (page <= 4).then(|| format!("option-roll-{}", page + 1));
    json!({
        "snapshots": {
            (symbol): {
                "latestQuote":{"bp":1.2,"ap":1.4,"t":"2026-10-07T14:12:00Z"},
                "latestTrade":{"p":1.3,"t":"2026-10-07T14:08:00Z"},
                "impliedVolatility":0.2,
                "greeks":{"delta":0.5}
            }
        },
        "next_page_token": next_token
    })
}

#[derive(Serialize)]
struct ReadClaims<'a> {
    sub: &'a str,
    iss: &'a str,
    aud: &'a str,
    iat: usize,
    exp: usize,
    jti: &'a str,
    idp_iss: &'a str,
    scope: Vec<&'a str>,
}

fn token(secret: &[u8], kid: &str, issuer: &str, scopes: Vec<&str>) -> String {
    let now = Utc::now().timestamp().max(0) as usize;
    let mut header = Header::new(Algorithm::HS256);
    header.kid = Some(kid.to_owned());
    encode(
        &header,
        &ReadClaims {
            sub: "openbb-test-user",
            iss: issuer,
            aud: GATEWAY_AUDIENCE,
            iat: now,
            exp: now + 60,
            jti: "openbb-test-token",
            idp_iss: "https://identity.example",
            scope: scopes,
        },
        &EncodingKey::from_secret(secret),
    )
    .expect("test token encodes")
}

fn test_keys() -> (AuthKeyring, Vec<u8>, Vec<u8>) {
    let bff = vec![b'b'; 64];
    let research = vec![b'r'; 64];
    (
        AuthKeyring {
            bff: Some(Arc::new(bff.clone())),
            research: Some(Arc::new(research.clone())),
        },
        bff,
        research,
    )
}

fn openbb_app(data: AlpacaData, keys: AuthKeyring) -> Router {
    let (stock_tx, _) = watch::channel(Vec::<String>::new());
    let (option_tx, _) = watch::channel(Vec::<String>::new());
    let (broadcasts, _) = broadcast::channel(16);
    let state = AppState {
        data: Some(data),
        stock_feed: "sip".into(),
        option_feed: "opra".into(),
        requested_execution_mode: "disabled".into(),
        execution_enabled: false,
        auth_keys: keys.clone(),
        stock_symbols: Vec::new(),
        max_stock_subscriptions: 100,
        stock_tx,
        stock_leases: Arc::default(),
        max_option_subscriptions: 500,
        option_tx,
        option_leases: Arc::default(),
        broadcasts,
        tickets: Arc::default(),
        previews: PreviewStore::default(),
        risk: RiskPolicy {
            max_qty: 10,
            max_loss: 1_000.0,
        },
        brokers: BrokerRouter::from_adapters(HashMap::new()),
        audit_path: "unused-openbb-test-audit.jsonl".into(),
        audit_lock: Arc::default(),
        chains: Arc::default(),
    };
    Router::new()
        .route("/openbb/v1/stocks", get(openbb_stocks))
        .route("/openbb/v1/options", get(openbb_options))
        .route("/openbb/v1/bars", get(openbb_bars))
        .route_layer(middleware::from_fn_with_state(Arc::new(keys), require_auth))
        .with_state(state)
}

async fn get_json(app: &Router, path: &str, bearer: Option<&str>) -> (StatusCode, Value) {
    let mut request = axum::http::Request::builder().uri(path);
    if let Some(token) = bearer {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(axum::body::Body::empty()).unwrap())
        .await
        .expect("Gateway test router responds");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1_048_576)
        .await
        .expect("Gateway response body reads");
    let body = serde_json::from_slice(&bytes).expect("Gateway response is JSON");
    (status, body)
}

#[tokio::test]
async fn openbb_market_rows_preserve_source_time_feed_and_pagination() {
    let upstream = MockServer::start(200, None).await;
    let (keys, _bff, research) = test_keys();
    let research_token = token(&research, "research", RESEARCH_ISSUER, vec!["market:read"]);
    let app = openbb_app(
        AlpacaData::with_test_endpoint(&upstream.base).expect("mock endpoint is allowed"),
        keys,
    );

    let (anon_status, _) = get_json(&app, "/openbb/v1/stocks?symbols=QQQ", None).await;
    assert_eq!(anon_status, StatusCode::UNAUTHORIZED);
    let no_scope = token(&_bff, "bff", BFF_ISSUER, vec!["workspace:read"]);
    let (scope_status, _) = get_json(&app, "/openbb/v1/stocks?symbols=QQQ", Some(&no_scope)).await;
    assert_eq!(scope_status, StatusCode::FORBIDDEN);
    assert!(upstream.requests().is_empty());

    let (stock_status, stocks) = get_json(
        &app,
        "/openbb/v1/stocks?symbols=QQQ%2CMISSING",
        Some(&research_token),
    )
    .await;
    assert_eq!(stock_status, StatusCode::OK);
    assert_eq!(stocks.as_array().unwrap().len(), 2);
    let qqq = &stocks[0];
    assert_eq!(qqq["last"], 600.25);
    assert_eq!(qqq["last_basis"], "trade");
    assert!(qqq["trade_at"].is_null());
    assert_eq!(qqq["quote_at"], "2026-10-07T14:10:00Z");
    assert!(qqq["market_as_of"].is_null());
    assert_eq!(qqq["feed"], "sip");
    assert_eq!(qqq["source_mode"], "unknown");
    assert_eq!(qqq["source_label"], "source unknown");
    assert_eq!(qqq["time_complete"], false);
    assert_eq!(qqq["complete"], false);
    assert_eq!(stocks[1]["snapshot_present"], false);
    assert_eq!(stocks[1]["last"], Value::Null);
    assert_eq!(stocks[1]["complete"], false);

    let (bars_status, bars) = get_json(
        &app,
        "/openbb/v1/bars?symbol=QQQ&timeframe=1Min&limit=3&days=1",
        Some(&research_token),
    )
    .await;
    assert_eq!(bars_status, StatusCode::OK);
    assert_eq!(bars.as_array().unwrap().len(), 3);
    assert_eq!(bars[0]["time"], "2026-10-07T12:00:00Z");
    assert_eq!(bars[0]["market_as_of"], bars[0]["time"]);
    assert_eq!(bars[0]["feed"], "sip");
    assert_eq!(bars[0]["pages_fetched"], 2);
    assert_eq!(bars[0]["has_more"], false);
    assert_eq!(bars[0]["truncated"], false);
    assert_eq!(bars[0]["complete"], true);
    assert_eq!(bars[0]["source_mode"], "unknown");

    let (truncated_status, truncated) = get_json(
        &app,
        "/openbb/v1/bars?symbol=QQQ&timeframe=1Min&limit=1&days=1",
        Some(&research_token),
    )
    .await;
    assert_eq!(truncated_status, StatusCode::OK);
    assert_eq!(truncated.as_array().unwrap().len(), 1);
    assert_eq!(truncated[0]["pages_fetched"], 1);
    assert_eq!(truncated[0]["has_more"], true);
    assert_eq!(truncated[0]["truncated"], true);
    assert_eq!(truncated[0]["complete"], false);

    let (options_status, options) = get_json(
        &app,
        "/openbb/v1/options?underlying=QQQ&expiration=2026-10-09",
        Some(&research_token),
    )
    .await;
    assert_eq!(options_status, StatusCode::OK);
    assert_eq!(options.as_array().unwrap().len(), 2);
    assert_eq!(options[0]["feed"], "opra");
    assert_eq!(options[0]["source_mode"], "unknown");
    assert_eq!(options[0]["pages_fetched"], 2);
    assert_eq!(options[0]["has_more"], false);
    assert_eq!(options[0]["truncated"], false);
    assert_eq!(options[1]["quote_at"], "2026-10-07T14:12:00Z");
    assert_eq!(options[1]["trade_at"], "2026-10-07T14:08:00Z");
    assert_eq!(options[1]["market_as_of"], options[1]["quote_at"]);
    assert!(options[1]["model_as_of"].is_null());

    let (chain_status, bounded_chain) = get_json(
        &app,
        "/openbb/v1/options?underlying=QQQ&expiration=2026-10-10",
        Some(&research_token),
    )
    .await;
    assert_eq!(chain_status, StatusCode::OK);
    assert_eq!(bounded_chain.as_array().unwrap().len(), 5);
    assert_eq!(bounded_chain[0]["pages_fetched"], 5);
    assert_eq!(bounded_chain[0]["has_more"], true);
    assert_eq!(bounded_chain[0]["truncated"], true);
    assert_eq!(bounded_chain[0]["complete"], false);

    let requests = upstream.requests();
    assert!(requests.iter().any(|uri| {
        uri.starts_with("/v2/stocks/snapshots?")
            && uri.contains("symbols=QQQ%2CMISSING")
            && uri.contains("feed=sip")
    }));
    assert!(requests.iter().any(|uri| {
        uri.starts_with("/v2/stocks/QQQ/bars?")
            && uri.contains("timeframe=1Min")
            && uri.contains("feed=sip")
            && uri.contains("page_token=bars-page-2")
    }));
    assert!(requests.iter().any(|uri| {
        uri.starts_with("/v1beta1/options/snapshots/QQQ?")
            && uri.contains("expiration_date=2026-10-09")
            && uri.contains("feed=opra")
            && uri.contains("page_token=options-page-2")
    }));
    upstream.stop();
}

#[tokio::test]
async fn openbb_bars_reject_malformed_rows_and_repeated_page_tokens() {
    let upstream = MockServer::start(200, None).await;
    let (keys, _, research) = test_keys();
    let bearer = token(&research, "research", RESEARCH_ISSUER, vec!["market:read"]);
    let app = openbb_app(
        AlpacaData::with_test_endpoint(&upstream.base).expect("mock endpoint is allowed"),
        keys,
    );

    let (malformed_status, malformed) = get_json(
        &app,
        "/openbb/v1/bars?symbol=QQQ&timeframe=15Min&limit=2&days=1",
        Some(&bearer),
    )
    .await;
    assert_eq!(malformed_status, StatusCode::BAD_GATEWAY);
    assert_eq!(malformed["error"], "market_data_error");

    let (repeat_status, repeated) = get_json(
        &app,
        "/openbb/v1/bars?symbol=QQQ&timeframe=5Min&limit=3&days=1",
        Some(&bearer),
    )
    .await;
    assert_eq!(repeat_status, StatusCode::BAD_GATEWAY);
    assert_eq!(repeated["error"], "market_data_error");
    let requests = upstream.requests();
    let repeated_page_calls = requests
        .iter()
        .filter(|uri| uri.contains("timeframe=5Min"))
        .count();
    assert_eq!(repeated_page_calls, 2);
    upstream.stop();
}

#[tokio::test]
async fn openbb_rejects_malformed_option_symbols_and_page_tokens() {
    let upstream = MockServer::start(200, None).await;
    let (keys, _, research) = test_keys();
    let bearer = token(&research, "research", RESEARCH_ISSUER, vec!["market:read"]);
    let app = openbb_app(
        AlpacaData::with_test_endpoint(&upstream.base).expect("mock endpoint is allowed"),
        keys,
    );

    let (missing_status, missing_rows) = get_json(
        &app,
        "/openbb/v1/bars?symbol=QQQ&timeframe=1Hour&limit=2&days=1",
        Some(&bearer),
    )
    .await;
    assert_eq!(missing_status, StatusCode::OK);
    assert_eq!(missing_rows.as_array().unwrap().len(), 1);
    assert_eq!(missing_rows[0]["has_more"], false);
    assert_eq!(missing_rows[0]["complete"], true);

    for timeframe in ["1Day", "1Week", "1Month"] {
        let path = format!("/openbb/v1/bars?symbol=QQQ&timeframe={timeframe}&limit=2&days=1");
        let (status, body) = get_json(&app, &path, Some(&bearer)).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{timeframe}");
        assert_eq!(body["error"], "market_data_error", "{timeframe}");
    }

    let (occ_status, occ_body) = get_json(
        &app,
        "/openbb/v1/options?underlying=QQQ&expiration=2026-10-11",
        Some(&bearer),
    )
    .await;
    assert_eq!(occ_status, StatusCode::BAD_GATEWAY);
    assert_eq!(occ_body["error"], "market_data_error");

    for expiration in ["2026-10-12", "2026-10-13", "2026-10-14"] {
        let path = format!("/openbb/v1/options?underlying=QQQ&expiration={expiration}");
        let (status, body) = get_json(&app, &path, Some(&bearer)).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{expiration}");
        assert_eq!(body["error"], "market_data_error", "{expiration}");
    }

    let (mismatch_status, mismatch_body) = get_json(
        &app,
        "/openbb/v1/options?underlying=QQQ&expiration=2026-10-15",
        Some(&bearer),
    )
    .await;
    assert_eq!(mismatch_status, StatusCode::BAD_GATEWAY);
    assert_eq!(mismatch_body["error"], "market_data_error");

    upstream.stop();
}

#[tokio::test]
async fn openbb_empty_truncated_pages_fail_closed_and_complete_empty_pages_stay_empty() {
    let upstream = MockServer::start(200, None).await;
    let (keys, _, research) = test_keys();
    let bearer = token(&research, "research", RESEARCH_ISSUER, vec!["market:read"]);
    let app = openbb_app(
        AlpacaData::with_test_endpoint(&upstream.base).expect("mock endpoint is allowed"),
        keys,
    );

    let (bars_error_status, bars_error) = get_json(
        &app,
        "/openbb/v1/bars?symbol=QQQ&timeframe=1Min&limit=2&days=1",
        Some(&bearer),
    )
    .await;
    assert_eq!(bars_error_status, StatusCode::BAD_GATEWAY);
    assert_eq!(bars_error["error"], "market_data_truncated");
    assert!(bars_error["detail"].as_str().unwrap().contains("truncated"));
    assert_eq!(bars_error["source"], "unknown");
    assert_eq!(bars_error["feed"], "sip");
    assert_eq!(bars_error["pages_fetched"], 5);
    assert_eq!(bars_error["has_more"], true);
    assert_eq!(bars_error["truncated"], true);
    assert!(bars_error.get("page_token").is_none());

    let (options_error_status, options_error) = get_json(
        &app,
        "/openbb/v1/options?underlying=QQQ&expiration=2026-10-17",
        Some(&bearer),
    )
    .await;
    assert_eq!(options_error_status, StatusCode::BAD_GATEWAY);
    assert_eq!(options_error["error"], "market_data_truncated");
    assert!(options_error["detail"]
        .as_str()
        .unwrap()
        .contains("truncated"));
    assert_eq!(options_error["source"], "unknown");
    assert_eq!(options_error["feed"], "opra");
    assert_eq!(options_error["pages_fetched"], 5);
    assert_eq!(options_error["has_more"], true);
    assert_eq!(options_error["truncated"], true);
    assert!(options_error.get("page_token").is_none());

    let (empty_bars_status, empty_bars) = get_json(
        &app,
        "/openbb/v1/bars?symbol=QQQ&timeframe=1Hour&limit=4&days=1",
        Some(&bearer),
    )
    .await;
    assert_eq!(empty_bars_status, StatusCode::OK);
    assert_eq!(empty_bars, json!([]));

    let (empty_options_status, empty_options) = get_json(
        &app,
        "/openbb/v1/options?underlying=QQQ&expiration=2026-10-18",
        Some(&bearer),
    )
    .await;
    assert_eq!(empty_options_status, StatusCode::OK);
    assert_eq!(empty_options, json!([]));

    let (later_bar_status, later_bars) = get_json(
        &app,
        "/openbb/v1/bars?symbol=QQQ&timeframe=1Week&limit=3&days=1",
        Some(&bearer),
    )
    .await;
    assert_eq!(later_bar_status, StatusCode::OK);
    assert_eq!(later_bars.as_array().unwrap().len(), 1);
    assert_eq!(later_bars[0]["pages_fetched"], 2);
    assert_eq!(later_bars[0]["has_more"], false);
    assert_eq!(later_bars[0]["truncated"], false);
    assert_eq!(later_bars[0]["complete"], true);

    let requests = upstream.requests();
    assert_eq!(
        requests
            .iter()
            .filter(|uri| uri.contains("timeframe=1Min") && uri.contains("limit=2"))
            .count(),
        5
    );
    assert_eq!(
        requests
            .iter()
            .filter(|uri| uri.contains("expiration_date=2026-10-17"))
            .count(),
        5
    );
    upstream.stop();
}

#[tokio::test]
async fn openbb_market_source_401_and_403_are_explicit() {
    let (keys, _, research) = test_keys();
    let bearer = token(&research, "research", RESEARCH_ISSUER, vec!["market:read"]);
    for status in [401, 403] {
        let upstream = MockServer::start(status, None).await;
        let app = openbb_app(
            AlpacaData::with_test_endpoint(&upstream.base).expect("mock endpoint is allowed"),
            keys.clone(),
        );
        let (response_status, body) =
            get_json(&app, "/openbb/v1/stocks?symbols=QQQ", Some(&bearer)).await;
        assert_eq!(response_status.as_u16(), status);
        assert_eq!(body["error"], "market_data_error");
        assert!(body["detail"]
            .as_str()
            .unwrap()
            .contains(&status.to_string()));
        assert_eq!(upstream.requests().len(), 1);
        upstream.stop();
    }
}

#[tokio::test]
async fn alpaca_http_client_does_not_forward_credentials_through_redirects() {
    let target = MockServer::start(200, None).await;
    let redirect = format!("{}/v2/stocks/snapshots", target.base);
    let source = MockServer::start(302, Some(redirect)).await;
    let data = AlpacaData::with_test_endpoint(&source.base).expect("mock endpoint is allowed");
    let error = data
        .stock_snapshots(&["QQQ".into()])
        .await
        .expect_err("redirect is not followed");
    assert!(matches!(error, DataError::Http(302)));
    assert_eq!(error.status_code(), StatusCode::BAD_GATEWAY);
    assert_eq!(source.requests().len(), 1);
    assert!(target.requests().is_empty());
    source.stop();
    target.stop();
}
