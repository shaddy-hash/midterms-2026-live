#!/usr/bin/env python3
"""Fetch live Kalshi market prices and election headlines, write data/data.json and data/history.json.

Runs inside GitHub Actions. Standard library only.
"""
import json
import os
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

API = "https://api.elections.kalshi.com/trade-api/v2/events/{}?with_nested_markets=true"
OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else "data"

SENATE_EVENTS = {
    "TX": "SENATETX-26", "MI": "SENATEMI-26", "ME": "SENATEME-26", "IA": "SENATEIA-26",
    "OH": "SENATEOHS-26", "KS": "SENATEKS-26", "NE": "SENATENE-26", "SC": "SENATESC-26",
    "AK": "SENATEAK-26", "NC": "SENATENC-26", "NH": "SENATENH-26", "GA": "SENATEGA-26",
    "FL": ["SENATEFL-26", "SENATEFLS-26"], "MN": "SENATEMN-26",
}
CONTROL_EVENTS = {"senate": "CONTROLS-2026", "house": "CONTROLH-2026", "combo": "KXBALANCEPOWERCOMBO-27FEB"}

HEADLINE_FEEDS = [
    "https://news.google.com/rss/search?q=%22election+results%22+senate+OR+house+when:1d&hl=en-US&gl=US&ceid=US:en",
    "https://news.google.com/rss/search?q=AP+projects+senate+race+when:1d&hl=en-US&gl=US&ceid=US:en",
]

UA = {"User-Agent": "midterms-2026-live-dashboard/1.0", "Accept": "application/json"}


def get(url, accept_json=True, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA if accept_json else {"User-Agent": UA["User-Agent"]})
            with urllib.request.urlopen(req, timeout=20) as r:
                body = r.read()
            return json.loads(body) if accept_json else body
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                print(f"WARN fetch failed {url}: {e}", file=sys.stderr)
                return None
            time.sleep(1.5 * (i + 1))


def f(x):
    try:
        return round(float(x) * 100, 1)
    except (TypeError, ValueError):
        return None


def market_view(m):
    bid, ask, last = f(m.get("yes_bid_dollars")), f(m.get("yes_ask_dollars")), f(m.get("last_price_dollars"))
    mid = round((bid + ask) / 2, 1) if bid is not None and ask is not None and ask > 0 else last
    return {
        "ticker": m.get("ticker"),
        "name": m.get("yes_sub_title") or m.get("title"),
        "price": mid,
        "last": last,
        "prev": f(m.get("previous_price_dollars")),
        "status": m.get("status"),
        "result": m.get("result") or "",
        "volume24h": m.get("volume_24h_fp"),
    }


def fetch_event(ticker):
    j = get(API.format(ticker))
    if not j:
        return None
    ev = j.get("event") or {}
    markets = ev.get("markets") or j.get("markets") or []
    return {"ticker": ticker, "title": ev.get("title"), "markets": [market_view(m) for m in markets]}


def headlines():
    seen, items = set(), []
    for url in HEADLINE_FEEDS:
        raw = get(url, accept_json=False)
        if not raw:
            continue
        try:
            root = ET.fromstring(raw)
        except ET.ParseError:
            continue
        for it in root.iter("item"):
            title = (it.findtext("title") or "").strip()
            link = (it.findtext("link") or "").strip()
            src = it.find("source")
            source = src.text.strip() if src is not None and src.text else ""
            if source and title.endswith(" - " + source):
                title = title[: -(len(source) + 3)]
            key = title.lower()[:80]
            if not title or key in seen:
                continue
            seen.add(key)
            pub = it.findtext("pubDate") or ""
            try:
                ts = datetime.strptime(pub, "%a, %d %b %Y %H:%M:%S %Z").replace(tzinfo=timezone.utc).isoformat()
            except ValueError:
                ts = None
            items.append({"title": title, "link": link, "source": source, "published": ts})
    items.sort(key=lambda x: x["published"] or "", reverse=True)
    return items[:25]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    control = {k: fetch_event(t) for k, t in CONTROL_EVENTS.items()}
    senate = {}
    for st, t in SENATE_EVENTS.items():
        for tk in (t if isinstance(t, list) else [t]):
            senate[st] = fetch_event(tk)
            if senate[st]:
                break
    data = {"updated": now, "control": control, "senate": senate, "headlines": headlines()}

    with open(os.path.join(OUT_DIR, "data.json"), "w") as fh:
        json.dump(data, fh, separators=(",", ":"))

    # Append a compact history point for the trend chart.
    def dem_price(ev):
        if not ev:
            return None
        for m in ev["markets"]:
            if (m["ticker"] or "").endswith("-D"):
                return m["price"]
        return None

    point = {"t": now, "senate": dem_price(control.get("senate")), "house": dem_price(control.get("house"))}
    hist_path = os.path.join(OUT_DIR, "history.json")
    try:
        with open(hist_path) as fh:
            hist = json.load(fh)
    except (OSError, ValueError):
        hist = []
    if point["senate"] is not None or point["house"] is not None:
        hist.append(point)
    hist = hist[-600:]
    with open(hist_path, "w") as fh:
        json.dump(hist, fh, separators=(",", ":"))
    ok = sum(1 for v in senate.values() if v)
    print(f"{now}: control={[k for k, v in control.items() if v]} senate_events={ok} headlines={len(data['headlines'])}")


if __name__ == "__main__":
    main()
