//! HTTP projection of the existing local Futu worker; authentication remains in the route owner.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

use crate::{
    fail,
    futu_local::{FutuLocal, HistoryBarsRequest},
};

pub(crate) async fn read(futu: &FutuLocal, request: &HistoryBarsRequest) -> Response {
    match futu.history_bars(request).await {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => match error.as_str() {
            "UNSUPPORTED_PROVIDER_CAPABILITY" => fail(
                StatusCode::NOT_IMPLEMENTED,
                "UNSUPPORTED_PROVIDER_CAPABILITY",
                "Futu does not support this history request",
            ),
            "invalid_bars_query"
            | "invalid_limit"
            | "invalid_days"
            | "invalid_start"
            | "invalid_end"
            | "invalid_cursor"
            | "cursor_query_mismatch" => fail(
                StatusCode::BAD_REQUEST,
                "invalid_bars_query",
                "invalid Futu history query",
            ),
            "futu_history_permission_denied" => fail(
                StatusCode::FORBIDDEN,
                "futu_history_permission_denied",
                "Futu history permission unavailable",
            ),
            "futu_rate_limited" => fail(
                StatusCode::TOO_MANY_REQUESTS,
                "futu_rate_limited",
                "Futu history request rate exceeded",
            ),
            "futu_timeout" => fail(
                StatusCode::GATEWAY_TIMEOUT,
                "futu_timeout",
                "Futu history request timed out",
            ),
            "futu_login_rejected" => fail(
                StatusCode::SERVICE_UNAVAILABLE,
                "futu_login_rejected",
                "Futu worker login was rejected",
            ),
            "futu_disconnected" | "futu_queue_full" => fail(
                StatusCode::SERVICE_UNAVAILABLE,
                "futu_disconnected",
                "Futu history worker unavailable",
            ),
            "futu_invalid_response" => fail(
                StatusCode::BAD_GATEWAY,
                "futu_invalid_response",
                "Futu history response validation failed",
            ),
            _ => fail(
                StatusCode::BAD_GATEWAY,
                "futu_read_failed",
                "Futu history read failed",
            ),
        },
    }
}
