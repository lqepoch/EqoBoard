#!/usr/bin/env python3
"""Local-only read-only QQQ historical SIP export: one atomic Parquet per ISO week.

This is independent from any trading/order API and is never run by public Actions.
The operator supplies credentials in a local process environment. Output may be
licensed market data; keep it outside the checkout and do not commit or publish it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, time as daytime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pyarrow as pa
import pyarrow.parquet as pq

HOST = "https://data.alpaca.markets/v2/stocks/QQQ/trades"
NY = ZoneInfo("America/New_York")
UTC = timezone.utc
# Reconciled against Alpaca's 2026-01-01..2026-09-30 trading calendar (187 sessions).
MARKET_HOLIDAYS = {
    date(2026, 1, 1), date(2026, 1, 19), date(2026, 2, 16),
    date(2026, 4, 3), date(2026, 5, 25), date(2026, 6, 19),
    date(2026, 7, 3), date(2026, 9, 7),
}
START, END = date(2026, 1, 1), date(2026, 9, 30)

def trading_sessions() -> dict[str, list[date]]:
    result: dict[str, list[date]] = {}
    day = START
    while day <= END:
        if day.weekday() < 5 and day not in MARKET_HOLIDAYS:
            y, w, _ = day.isocalendar()
            key = f"{y}-W{w:02}"
            result.setdefault(key, []).append(day)
        day += timedelta(days=1)
    assert sum(map(len, result.values())) == 187 and len(result) == 40, "Calendar mismatch"
    return result

def to_ns(stamp: str) -> int:
    m = re.fullmatch(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z", stamp)
    if not m:
        raise ValueError("Unexpected Alpaca timestamp format")
    seconds = datetime.fromisoformat(m.group(1)).replace(tzinfo=UTC)
    return int(seconds.timestamp()) * 1_000_000_000 + int((m.group(2) or "").ljust(9, "0"))

def market_bounds(day: date) -> tuple[str,str,int,int]:
    st = datetime.combine(day, daytime(9,30), NY).astimezone(UTC)
    en = datetime.combine(day, daytime(16,0), NY).astimezone(UTC)
    return st.isoformat().replace("+00:00", "Z"), en.isoformat().replace("+00:00", "Z"), int(st.timestamp())*10**9, int(en.timestamp())*10**9

def get_page(params: dict[str, str]) -> dict:
    key = os.environ.get("ALPACA_KEY", "")
    secret = os.environ.get("ALPACA_SECRET", "")
    if not key or not secret:
        raise RuntimeError("Protected ALPACA_KEY and ALPACA_SECRET secrets required")
    endpoint = HOST + "?" + urllib.parse.urlencode(params)
    for retry in range(11):
        request = urllib.request.Request(endpoint, headers={
            "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret,
            "Accept": "application/json",
            "User-Agent": "EqoBoard-QQQ-Historical-SIP-Weekly-Export/1.0",
        }, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                result = json.load(response)
            if not isinstance(result, dict) or not isinstance(result.get("trades"), list):
                raise RuntimeError("Bad Alpaca trade response")
            return result
        except urllib.error.HTTPError as exc:
            if exc.code in (401,403):
                raise RuntimeError(f"Historical SIP permission/auth failed (HTTP {exc.code}); no feed fallback") from None
            if exc.code not in (429,500,502,503,504) or retry == 10:
                raise RuntimeError(f"Alpaca HTTP {exc.code}; trade export halted") from None
            try:
                delay = max(int(exc.headers.get("Retry-After","0")), min(60,2**retry))
            except (ValueError,TypeError):
                delay = min(60,2**retry)
            time.sleep(delay + random.random())
        except (urllib.error.URLError,TimeoutError) as exc:
            if retry == 10:
                raise RuntimeError("Alpaca network retries exhausted") from exc
            time.sleep(min(60,2**retry) + random.random())
    raise AssertionError("unreachable")

SCHEMA=pa.schema([
    pa.field("timestamp_ns",pa.timestamp("ns",tz="UTC"),nullable=False),
    pa.field("timestamp_utc",pa.string(),nullable=False),
    pa.field("symbol",pa.string(),nullable=False),
    pa.field("price",pa.float64(),nullable=False),
    pa.field("size",pa.int64(),nullable=False),
    pa.field("exchange",pa.string(),nullable=False),
    pa.field("trade_id",pa.string(),nullable=False),
    pa.field("conditions",pa.list_(pa.string()),nullable=False),
    pa.field("tape",pa.string(),nullable=False),
    pa.field("session_date",pa.string(),nullable=False),
],metadata={b"symbol":b"QQQ",b"feed":b"sip",b"provider":b"Alpaca",b"scope":b"09:30:00..16:00:00 America/New_York"})

def run_week(week: str, output: Path) -> dict:
    groups=trading_sessions()
    if week not in groups:
        raise ValueError("Week absent from requested 2026 date range")
    output.mkdir(parents=True,exist_ok=True)
    name=f"QQQ_SIP_Trades_{week}.parquet"
    final=output/name
    partial=output/f"{name}.inprogress"
    manifest=output/f"{name}.manifest.json"
    if final.exists():
        raise RuntimeError("An output file already exists; remove manually after verification")
    partial.unlink(missing_ok=True)
    counts={}
    total=0
    pages=0
    start_time=time.monotonic()
    with pq.ParquetWriter(partial,SCHEMA,compression="zstd",compression_level=5,write_statistics=True,use_dictionary=True) as writer:
        for day in groups[week]:
            begin,end,lo,hi=market_bounds(day)
            params={"start":begin,"end":end,"limit":"10000","feed":"sip","sort":"asc"}
            seen=set()
            previous=-1
            count=0
            while True:
                payload=get_page(params)
                data=payload["trades"]
                cols={field.name:[] for field in SCHEMA}
                for item in data:
                    stamp=str(item["t"])
                    ns=to_ns(stamp)
                    if not(lo <= ns <= hi):
                        raise RuntimeError("Alpaca trade returned outside requested market session")
                    if ns<previous:
                        raise RuntimeError("Out-of-order Alpaca page")
                    previous=ns
                    cols["timestamp_ns"].append(ns)
                    cols["timestamp_utc"].append(stamp)
                    cols["symbol"].append("QQQ")
                    cols["price"].append(float(item["p"]))
                    cols["size"].append(int(item["s"]))
                    cols["exchange"].append(str(item.get("x") or ""))
                    cols["trade_id"].append(str(item.get("i") or ""))
                    cols["conditions"].append(list(item.get("c") or []))
                    cols["tape"].append(str(item.get("z") or ""))
                    cols["session_date"].append(day.isoformat())
                if data:
                    if any(n<=0 for n in cols["size"]) or any(p<=0 for p in cols["price"]):
                        raise RuntimeError("Invalid source trade values")
                    writer.write_table(pa.Table.from_pydict(cols,schema=SCHEMA),row_group_size=10000)
                    count+=len(data)
                pages+=1
                token=payload.get("next_page_token")
                if not token:
                    break
                if not isinstance(token,str) or token in seen:
                    raise RuntimeError("Invalid/repeated pagination token")
                seen.add(token)
                params["page_token"]=token
                # Rate-limit a single task; max parallelism also capped by workflow.
                time.sleep(0.14)
            if count<=0:
                raise RuntimeError(f"Zero SIP trades on market day {day}")
            counts[day.isoformat()]=count
            total+=count
            print(f"DAY {week} {day} trades={count} pages={len(seen)+1}",flush=True)
    # .inprogress cannot be mistaken for a completed week
    partial.replace(final)
    sha=hashlib.sha256()
    md5=hashlib.md5()
    with final.open("rb") as f:
        for block in iter(lambda:f.read(8*1024*1024),b""):
            sha.update(block);md5.update(block)
    footer=pq.ParquetFile(final)
    if footer.metadata.num_rows!=total:
        raise RuntimeError("Parquet footer row count mismatch")
    meta={
        "source":"Alpaca SIP","symbol":"QQQ","week":week,
        "sessions":len(groups[week]),"day_counts":counts,
        "rows":total,"pages":pages,"sha256":sha.hexdigest(),"md5":md5.hexdigest(),
        "size_bytes":final.stat().st_size,"utc_timestamp_precision":"ns",
        "session_window":"09:30:00..16:00:00 America/New_York inclusive",
        "complete_only_if":"Each trading day had no next_page_token on last page, Parquet footer count equals row count",
    }
    manifest.write_text(json.dumps(meta,indent=2,ensure_ascii=False),encoding="utf-8")
    print(f"WEEK COMPLETE {week} rows={total} pages={pages} bytes={final.stat().st_size} elapsed_s={int(time.monotonic()-start_time)}",flush=True)
    return meta

if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--week",required=True,help="ISO week such as 2026-W01")
    p.add_argument("--out",default="export")
    args=p.parse_args()
    try:
        run_week(args.week,Path(args.out))
    except Exception:
        # Fail closed: no uploads until a complete/verified Parquet is produced
        print(f"FAILED {args.week}; incomplete data never marked complete",file=sys.stderr)
        raise
