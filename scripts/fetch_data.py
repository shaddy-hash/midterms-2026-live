#!/usr/bin/env python3
"""Fetch live election data and write JSON files for the dashboard.

Outputs (in OUT_DIR):
  data.json     - latest snapshot: Kalshi markets, seat counts, race calls, headlines, Truth Social posts
  history.json  - control odds every run (for the small trend chart)
  tracker.json  - one row per 5-minute bucket: predicted seats vs. seats called so far

Runs inside GitHub Actions. Standard library only.
"""
import html
import json
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

API = "https://api.elections.kalshi.com/trade-api/v2/events/{}?with_nested_markets=true"
OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else "data"

# All 35 Senate races on the 2026 ballot (33 regular + Ohio and Florida specials).
SENATE_STATES = ["AL", "AK", "AR", "CO", "DE", "GA", "ID", "IL", "IA", "KS", "KY", "LA", "ME", "MA", "MI", "MN",
                 "MS", "MT", "NE", "NH", "NJ", "NM", "NC", "OK", "OR", "RI", "SC", "SD", "TN", "TX", "VA", "WV",
                 "WY", "OH", "FL"]
SPECIAL = {"OH": ["SENATEOHS-26", "SENATEOH-26"], "FL": ["SENATEFLS-26", "SENATEFL-26"]}
NOT_UP = {"D": 34, "R": 31}  # seats not on the ballot (D count includes independents who caucus with Democrats)

CONTROL_EVENTS = {"senate": "CONTROLS-2026", "house": "CONTROLH-2026", "combo": "KXBALANCEPOWERCOMBO-27FEB"}
SEAT_EVENTS = {"house": "KXDHOUSESEATS-27", "senate": "KXDSENATESEATS-27"}

HEADLINE_FEEDS = [
    "https://news.google.com/rss/search?q=%22election+results%22+senate+OR+house+when:1d&hl=en-US&gl=US&ceid=US:en",
    "https://news.google.com/rss/search?q=AP+projects+senate+race+when:1d&hl=en-US&gl=US&ceid=US:en",
]
TRUTH_API = "https://truthsocial.com/api/v1/accounts/107780257626128497/statuses?exclude_replies=true&limit=40"
TRUTH_RSS = "https://www.trumpstruth.org/feed"
POLLCHECK_HOUSE = "https://www.pollcheck.co.uk/us-midterms-2026/data/house_map.json"

UA = "Mozilla/5.0 (compatible; midterms-2026-live-dashboard/1.1; +https://github.com/shaddy-hash/midterms-2026-live)"


def get(url, as_json=True, tries=2, timeout=20):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json" if as_json else "*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
            return json.loads(body) if as_json else body
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                print(f"WARN {url[:90]}: {e}", file=sys.stderr)
                return None
            time.sleep(1.0)


def pct(x):
    try:
        return round(float(x) * 100, 1)
    except (TypeError, ValueError):
        return None


def market_view(m):
    bid, ask, last = pct(m.get("yes_bid_dollars")), pct(m.get("yes_ask_dollars")), pct(m.get("last_price_dollars"))
    mid = round((bid + ask) / 2, 1) if bid is not None and ask is not None and ask > 0 else last
    return {"ticker": m.get("ticker"), "name": m.get("yes_sub_title") or m.get("title"), "price": mid,
            "last": last, "prev": pct(m.get("previous_price_dollars")), "status": m.get("status"),
            "result": m.get("result") or "", "floor": m.get("floor_strike"), "cap": m.get("cap_strike"),
            "strike": m.get("strike_type")}


def fetch_event(ticker):
    for tk in (ticker if isinstance(ticker, list) else [ticker]):
        j = get(API.format(tk))
        if j:
            ev = j.get("event") or {}
            ms = ev.get("markets") or j.get("markets") or []
            return {"ticker": tk, "title": ev.get("title"), "markets": [market_view(m) for m in ms]}
    return None


def party_of(m):
    t = m.get("ticker") or ""
    if t.endswith("-R"):
        return "R"
    if t.endswith("-D"):
        return "D"
    return "I"


def race_summary(ev):
    """Leader, call status and per-party chance for one race event."""
    if not ev or not ev["markets"]:
        return None
    ms = [m for m in ev["markets"] if m["price"] is not None]
    won = next((m for m in ev["markets"] if m["result"] == "yes"), None)
    top = max(ms, key=lambda m: m["price"]) if ms else None
    status, winner = "open", None
    if won:
        status, winner = "called", party_of(won)
    elif top and top["price"] >= 99:
        status, winner = "projected", party_of(top)
    by_party = {}
    for m in ms:
        p = party_of(m)
        by_party[p] = max(by_party.get(p, 0), m["price"])
    return {"status": status, "winner": winner, "winnerName": (won or top or {}).get("name") if winner else None,
            "leader": party_of(top) if top else None, "chance": by_party}


def expected_seats(ev):
    """Probability-weighted seat count from a Kalshi range ladder."""
    if not ev:
        return None
    tot = w = 0.0
    for m in ev["markets"]:
        p = m["price"] or 0
        lo, hi, st = m.get("floor"), m.get("cap"), m.get("strike")
        if st == "between" and lo is not None and hi is not None:
            mid = (lo + hi) / 2
        elif st == "less" and hi is not None:
            mid = hi - 3
        elif st == "greater" and lo is not None:
            mid = lo + 4
        else:
            continue
        tot += p * mid
        w += p
    return round(tot / w, 1) if w else None


def headlines():
    seen, items = set(), []
    for url in HEADLINE_FEEDS:
        raw = get(url, as_json=False)
        if not raw:
            continue
        try:
            root = ET.fromstring(raw)
        except ET.ParseError:
            continue
        for it in root.iter("item"):
            title = (it.findtext("title") or "").strip()
            src = it.find("source")
            source = src.text.strip() if src is not None and src.text else ""
            if source and title.endswith(" - " + source):
                title = title[: -(len(source) + 3)]
            key = title.lower()[:80]
            if not title or key in seen:
                continue
            seen.add(key)
            try:
                ts = datetime.strptime(it.findtext("pubDate") or "", "%a, %d %b %Y %H:%M:%S %Z").replace(tzinfo=timezone.utc).isoformat()
            except ValueError:
                ts = None
            items.append({"title": title, "link": (it.findtext("link") or "").strip(), "source": source, "published": ts})
    items.sort(key=lambda x: x["published"] or "", reverse=True)
    return items[:25]


def clean_html(s):
    s = re.sub(r"<br\s*/?>", "\n", s or "")
    s = re.sub(r"</p>\s*<p>", "\n\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    return html.unescape(s).strip()


def is_own_words(text):
    t = text.strip()
    if not t:
        return False  # media-only post
    if re.match(r"^RT[\s:@]", t):
        return False  # repost / re-truth
    if re.fullmatch(r"(https?://\S+\s*)+", t):
        return False  # bare link share
    return True


def truth_posts():
    posts, source = [], None
    j = get(TRUTH_API)
    if isinstance(j, list):
        source = "truthsocial.com"
        for s in j:
            if s.get("reblog"):
                continue
            text = clean_html(s.get("content"))
            if not is_own_words(text):
                continue
            posts.append({"text": text, "url": s.get("url"), "time": s.get("created_at"),
                          "media": len(s.get("media_attachments") or [])})
    if not posts:
        raw = get(TRUTH_RSS, as_json=False)
        if raw:
            try:
                root = ET.fromstring(raw)
                source = "trumpstruth.org archive"
                for it in root.iter("item"):
                    text = clean_html(it.findtext("description") or it.findtext("title") or "")
                    if not is_own_words(text) or text.startswith("[No Title]"):
                        continue
                    try:
                        ts = datetime.strptime(it.findtext("pubDate") or "", "%a, %d %b %Y %H:%M:%S %z").astimezone(timezone.utc).isoformat()
                    except ValueError:
                        ts = None
                    link = it.findtext("{http://www.w3.org/2005/Atom}link") or it.findtext("link") or ""
                    posts.append({"text": text, "url": link.strip(), "time": ts, "media": 0})
            except ET.ParseError:
                pass
    posts.sort(key=lambda p: p["time"] or "", reverse=True)
    return {"source": source, "posts": posts[:20]}


def house_calls():
    j = get(POLLCHECK_HOUSE)
    if not j or not isinstance(j.get("districts"), dict):
        return None
    c = {"D": 0, "R": 0, "I": 0, "counting": 0, "total": len(j["districts"])}
    calls = []
    for dist, v in j["districts"].items():
        call = v.get("call")
        if isinstance(call, dict) and call.get("p"):
            p = str(call["p"]).upper()
            p = "D" if p.startswith("D") else "R" if p.startswith("R") else "I"
            c[p] += 1
            calls.append({"d": dist, "p": p, "src": call.get("src"), "when": call.get("when")})
        if v.get("s") == "counting":
            c["counting"] += 1
    c["updated"] = j.get("updated_at")
    c["recent"] = calls[-15:]
    return c


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat(timespec="seconds")

    jobs = {f"c:{k}": v for k, v in CONTROL_EVENTS.items()}
    jobs.update({f"s:{k}": v for k, v in SEAT_EVENTS.items()})
    jobs.update({f"r:{st}": SPECIAL.get(st, f"SENATE{st}-26") for st in SENATE_STATES})
    with ThreadPoolExecutor(max_workers=10) as ex:
        futs = {k: ex.submit(fetch_event, v) for k, v in jobs.items()}
        f_head = ex.submit(headlines)
        f_truth = ex.submit(truth_posts)
        f_house = ex.submit(house_calls)
        res = {k: f.result() for k, f in futs.items()}
        heads, truth, hcalls = f_head.result(), f_truth.result(), f_house.result()

    control = {k: res[f"c:{k}"] for k in CONTROL_EVENTS}
    senate = {st: res[f"r:{st}"] for st in SENATE_STATES}
    summaries = {st: race_summary(ev) for st, ev in senate.items()}

    # Senate seats: called so far + market-expected total.
    s_called = {"D": 0, "R": 0, "I": 0}
    exp_d_races = 0.0
    for st, sm in summaries.items():
        if not sm:
            continue
        if sm["winner"]:
            s_called[sm["winner"]] += 1
        exp_d_races += (sm["chance"].get("D", 0)) / 100
    seats = {
        "senate": {"calledD": s_called["D"], "calledR": s_called["R"], "calledI": s_called["I"],
                   "racesCalled": sum(s_called.values()), "racesTotal": len(SENATE_STATES),
                   "notUpD": NOT_UP["D"], "notUpR": NOT_UP["R"],
                   "totalD": NOT_UP["D"] + s_called["D"], "totalR": NOT_UP["R"] + s_called["R"],
                   "expD_market": expected_seats(res["s:senate"]),
                   "expD_races": round(NOT_UP["D"] + exp_d_races, 1)},
        "house": {"calledD": hcalls["D"] if hcalls else None, "calledR": hcalls["R"] if hcalls else None,
                  "calledI": hcalls["I"] if hcalls else None, "counting": hcalls["counting"] if hcalls else None,
                  "racesTotal": 435, "sourceUpdated": hcalls["updated"] if hcalls else None,
                  "recent": hcalls["recent"] if hcalls else [],
                  "expD_market": expected_seats(res["s:house"])},
    }

    data = {"updated": now, "control": control, "senate": senate, "raceSummary": summaries, "seats": seats,
            "headlines": heads, "truth": truth}
    with open(os.path.join(OUT_DIR, "data.json"), "w") as fh:
        json.dump(data, fh, separators=(",", ":"))

    def dem(ev):
        if not ev:
            return None
        m = next((m for m in ev["markets"] if (m["ticker"] or "").endswith("-D")), None)
        return m["price"] if m else None

    # Small per-run history for the odds trend.
    hist_path = os.path.join(OUT_DIR, "history.json")
    try:
        hist = json.load(open(hist_path))
    except (OSError, ValueError):
        hist = []
    pt = {"t": now, "senate": dem(control.get("senate")), "house": dem(control.get("house"))}
    if pt["senate"] is not None or pt["house"] is not None:
        hist.append(pt)
    json.dump(hist[-600:], open(hist_path, "w"), separators=(",", ":"))

    # 5-minute tracker: predicted vs. actual seats. One row per bucket; the latest run in a bucket wins.
    bucket = now_dt.replace(minute=now_dt.minute - now_dt.minute % 5, second=0, microsecond=0).isoformat(timespec="minutes")
    row = {"t": bucket,
           "house": {"p": dem(control.get("house")), "exp": seats["house"]["expD_market"],
                     "d": seats["house"]["calledD"], "r": seats["house"]["calledR"]},
           "senate": {"p": dem(control.get("senate")), "exp": seats["senate"]["expD_market"] or seats["senate"]["expD_races"],
                      "d": seats["senate"]["totalD"], "r": seats["senate"]["totalR"],
                      "called": seats["senate"]["racesCalled"]}}
    tr_path = os.path.join(OUT_DIR, "tracker.json")
    try:
        tracker = json.load(open(tr_path))
    except (OSError, ValueError):
        tracker = []
    if tracker and tracker[-1]["t"] == bucket:
        tracker[-1] = row
    else:
        tracker.append(row)
    json.dump(tracker[-400:], open(tr_path, "w"), separators=(",", ":"))

    print(f"{now}: races={sum(1 for v in senate.values() if v)}/35 senateCalled={s_called} "
          f"house={'ok' if hcalls else 'none'} truth={truth['source']}:{len(truth['posts'])} heads={len(heads)}")


if __name__ == "__main__":
    main()
