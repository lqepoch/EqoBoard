#!/usr/bin/env python3
"""Local-only read-only diagnostic: response quota headers only, never credentials or raw trades."""
import os
import sys
import urllib.error
import urllib.request

URL = ("https://data.alpaca.markets/v2/stocks/QQQ/trades"
       "?feed=sip&start=2026-01-02T14%3A30%3A00Z"
       "&end=2026-01-02T14%3A30%3A01Z&limit=1&sort=asc")

def main():
    key, secret = os.environ.get("ALPACA_KEY"), os.environ.get("ALPACA_SECRET")
    print("credential_source=local_process_environment", flush=True)
    if not key or not secret:
        print("credential_presence=missing", flush=True)
        return 2
    print("credential_presence=both_set", flush=True)
    req=urllib.request.Request(URL, headers={
        "APCA-API-KEY-ID":key, "APCA-API-SECRET-KEY":secret,
        "Accept":"application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=40) as response:
            status, headers=response.status, response.headers
            response.read(2048)
    except urllib.error.HTTPError as exc:
        status,headers=exc.code,exc.headers
    except (urllib.error.URLError,TimeoutError) as exc:
        print("transport_status=unavailable",flush=True)
        return 3
    print(f"HTTP_STATUS={status}",flush=True)
    # Header allow-list contains no credential or trade data.
    for field in ("X-RateLimit-Limit","X-RateLimit-Remaining","X-RateLimit-Reset","Retry-After"):
        value=headers.get(field)
        if value is not None:
            print(field+"="+value,flush=True)
        else:
            print(field+"=<absent>",flush=True)
    return 0 if status == 200 else 4

if __name__=="__main__":
    sys.exit(main())
