"""Read-only Alpaca entitlement smoke. No order endpoints, no credential logging."""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request


def probe(path: str) -> dict:
    key = os.environ.get("ALPACA_KEY", "")
    secret = os.environ.get("ALPACA_SECRET", "")
    if not key or not secret:
        raise RuntimeError(
            "GitHub Actions secrets ALPACA_KEY / ALPACA_SECRET are not available; "
            "check organization-secret repository access."
        )
    # Market data host only; deliberately no trading host or POST methods.
    url = "https://data.alpaca.markets" + path
    req = urllib.request.Request(
        url,
        headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=18) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(
            f"Alpaca Market Data HTTP {exc.code} for read-only feed request."
        ) from None


def main() -> int:
    equity = probe("/v2/stocks/QQQ/snapshot?feed=sip")
    if not isinstance(equity, dict) or "latestQuote" not in equity:
        raise RuntimeError("SIP stock snapshot response is missing latestQuote")
    print("PASS: equity SIP read-only snapshot response")

    options = probe("/v1beta1/options/snapshots/QQQ?feed=opra&limit=1")
    if not isinstance(options, dict) or not isinstance(options.get("snapshots"), dict):
        raise RuntimeError("OPRA option chain response is missing snapshots")
    print(f"PASS: option OPRA read-only chain schema ({len(options['snapshots'])} returned)")
    print("No broker trading endpoint was called.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
