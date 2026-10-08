"""Alpaca SIP and OPRA authorization smoke (GET only, fail closed).

Both checks are independent. No market-data fallback, orders, or leaked secrets.
"""
from __future__ import annotations
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

HOST = "https://data.alpaca.markets"


class ProbeError(RuntimeError):
    def __init__(self, status: int, code: int | None = None):
        self.status = status
        self.code = code
        super().__init__(f"HTTP {status}" + (f" (Alpaca code {code})" if code is not None else ""))


def probe(path: str) -> dict:
    if not path.startswith("/") or path.startswith("//") or "@" in path:
        raise ValueError("Unsupported data endpoint path")
    key = os.getenv("ALPACA_KEY", "")
    secret = os.getenv("ALPACA_SECRET", "")
    if not key or not secret:
        raise RuntimeError("ALPACA_KEY/ALPACA_SECRET unavailable; provide them only in an authorized local process environment")
    req = urllib.request.Request(
        HOST + path,
        headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=18) as res:
            return json.load(res)
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read(4096))
            code = payload.get("code")
            numeric = int(code) if str(code).isdigit() else None
        except (ValueError, TypeError, OSError, AttributeError):
            numeric = None
        raise ProbeError(exc.code, numeric) from None


def diagnostic_old_sip(request) -> str:
    # Historical SIP > 45 minutes old. Never an IEX/indicative substitute.
    now = datetime.now(timezone.utc)
    args = urllib.parse.urlencode({
        "feed": "sip", "timeframe": "1Min",
        "start": (now - timedelta(minutes=90)).isoformat(),
        "end": (now - timedelta(minutes=45)).isoformat(), "limit": 1,
    })
    try:
        request("/v2/stocks/QQQ/bars?" + args)
        return "Old SIP historical request accepted; recent SIP entitlement may be absent"
    except ProbeError as exc:
        return "Old SIP historical request also rejected: " + str(exc)
    except Exception:
        return "Old SIP diagnostic unavailable"


def run_checks(request=probe) -> int:
    checks = [
        ("SIP", "/v2/stocks/QQQ/snapshot?feed=sip",
         lambda data: isinstance(data, dict) and
             any(isinstance(data.get(k), dict) for k in ("latestQuote", "latestTrade", "dailyBar"))),
        ("OPRA", "/v1beta1/options/snapshots/QQQ?feed=opra&limit=1",
         lambda data: isinstance(data, dict) and isinstance(data.get("snapshots"), dict)),
    ]
    failed = 0
    for name, endpoint, validate in checks:
        try:
            if not validate(request(endpoint)):
                raise RuntimeError("Expected market-data fields absent")
        except ProbeError as exc:
            failed += 1
            print(f"FAIL {name}: {exc}", file=sys.stderr)
            if name == "SIP" and exc.status == 403:
                print("DIAG SIP: " + diagnostic_old_sip(request), file=sys.stderr)
        except Exception as exc:
            failed += 1
            # Print only controlled exceptions, never arbitrary upstream messages.
            if type(exc) is RuntimeError:
                print(f"FAIL {name}: {exc}", file=sys.stderr)
            else:
                print(f"FAIL {name}: unexpected transport/response failure", file=sys.stderr)
        else:
            print(f"PASS {name}: authorized read-only Alpaca market-data response")
    print(f"RESULT: {len(checks) - failed}/{len(checks)} passed; orders never submitted")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(run_checks())
