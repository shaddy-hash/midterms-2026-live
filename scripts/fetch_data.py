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
NOT_UP = {"D": 34, "R": 31}
# Final poll closing time per state, hours ET on Nov 3 (25 = 1 AM Nov 4). Market-implied projections only count after this.
CLOSE_ET = {"AL": 20, "AK": 25, "AR": 20.5, "CO": 21, "DE": 20, "GA": 19, "ID": 23, "IL": 20, "IA": 22, "KS": 22, "KY": 19,
            "LA": 21, "ME": 20, "MA": 20, "MI": 21, "MN": 21, "MS": 20, "MT": 22, "NE": 22, "NH": 20, "NJ": 20, "NM": 21,
            "NC": 19.5, "OK": 20, "OR": 23, "RI": 20, "SC": 19, "SD": 22, "TN": 20, "TX": 22, "VA": 19, "WV": 19.5,
            "WY": 21, "OH": 19.5, "FL": 20,
            "AZ": 21, "CA": 23, "CT": 20, "HI": 24, "MD": 20, "NV": 22, "NY": 21, "PA": 20, "VT": 19, "WI": 21,
            "IN": 19, "MO": 20, "ND": 22, "UT": 22, "WA": 23}
GOV_STATES = ["KS", "NE", "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "FL", "GA", "HI", "ID", "IL", "IA", "ME", "MD", "MA",
              "MI", "MN", "NV", "NH", "NM", "NY", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "VT", "WI", "WY"]
SERIES_API = "https://api.elections.kalshi.com/trade-api/v2/events?series_ticker={}&with_nested_markets=true"


def fetch_series_event(series):
    """Newest event in a series (governor tickers vary by year suffix)."""
    j = get(SERIES_API.format(series))
    evs = (j or {}).get("events") or []
    if not evs:
        return None
    ev = sorted(evs, key=lambda e: e.get("event_ticker", ""))[-1]
    return {"ticker": ev.get("event_ticker"), "title": ev.get("title"),
            "markets": [market_view(m) for m in (ev.get("markets") or [])]}
ELECTION_DAY_UTC = datetime(2026, 11, 4, 0, 0, tzinfo=timezone.utc)  # 7 PM ET Nov 3 = 00:00 UTC Nov 4


def polls_closed(st, now_dt):
    from datetime import timedelta
    close_utc = ELECTION_DAY_UTC + timedelta(hours=CLOSE_ET.get(st, 25) - 19)
    return now_dt >= close_utc  # seats not on the ballot (D count includes independents who caucus with Democrats)

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


def get(url, as_json=True, tries=4, timeout=20):
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
            time.sleep(1.5 * (i + 1))


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


def race_summary(ev, closed=True):
    """Leader, call status and per-party chance for one race event."""
    if not ev or not ev["markets"]:
        return None
    ms = [m for m in ev["markets"] if m["price"] is not None]
    won = next((m for m in ev["markets"] if m["result"] == "yes"), None)
    top = max(ms, key=lambda m: m["price"]) if ms else None
    status, winner = "open", None
    if won:
        status, winner = "called", party_of(won)
    elif closed and top and top["price"] >= 99:
        status, winner = "projected", party_of(top)
    by_party = {}
    for m in ms:
        p = party_of(m)
        by_party[p] = max(by_party.get(p, 0), m["price"])
    return {"status": status, "winner": winner, "winnerName": (won or top or {}).get("name") if winner else None,
            "leader": party_of(top) if top else None, "chance": by_party, "closed": closed}


def expected_seats(ev):
    """Probability-weighted seat count from a Kalshi range ladder."""
    if not ev:
        return None
    tot = w = 0.0
    for m in ev["markets"]:
        p = m["price"] or 0
        lo, hi, st = m.get("floor"), m.get("cap"), m.get("strike")
        st = st or ""
        if st == "between" and lo is not None and hi is not None:
            mid = (lo + hi) / 2
        elif st.startswith("less") and hi is not None:
            mid = hi - (1 if hi - (lo or 0) > 50 else 2)  # open lower tail: just below the cap
        elif st.startswith("greater") and lo is not None:
            mid = lo + (1 if st.endswith("equal") else 4)  # open upper tail: just above the floor
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


BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://truthsocial.com/@realDonaldTrump", "Origin": "https://truthsocial.com"}


def get_browser(url, as_json=True):
    try:
        req = urllib.request.Request(url, headers=BROWSER_HEADERS)
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read()
        return json.loads(body) if as_json else body
    except Exception as e:  # noqa: BLE001
        print(f"WARN truth {url[:60]}: {e}", file=sys.stderr)
        return None


def relay_posts():
    """Posts pushed to truth.json by a browser relay (a signed-in Chrome tab on truthsocial.com)."""
    try:
        j = json.load(open(os.path.join(OUT_DIR, "truth.json")))
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(j["updated"].replace("Z", "+00:00"))).total_seconds()
        if age < 20 * 60 and j.get("posts"):
            return {"source": "truthsocial.com (live relay)", "posts": j["posts"][:20], "relayUpdated": j["updated"]}
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def truth_posts():
    relayed = relay_posts()
    if relayed:
        return relayed
    posts, source = [], None
    j = get_browser(TRUTH_API)
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
        raw = get_browser("https://truthsocial.com/@realDonaldTrump.rss", as_json=False)
        try:
            root = ET.fromstring(raw) if raw else None
        except ET.ParseError:
            root = None
        if root is not None:
            source = "truthsocial.com RSS"
            for it in root.iter("item"):
                text = clean_html(it.findtext("description") or "")
                if not is_own_words(text):
                    continue
                try:
                    ts = datetime.strptime(it.findtext("pubDate") or "", "%a, %d %b %Y %H:%M:%S %z").astimezone(timezone.utc).isoformat()
                except ValueError:
                    ts = None
                posts.append({"text": text, "url": (it.findtext("link") or "").strip(), "time": ts, "media": 0})
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
    c["all"] = calls
    return c


# ---------- composite forecast ----------
# Final published forecasts from major outlets (probability Democrats win; projected Democratic seats).
OUTLETS = {
    "house": {"prob": [("Decision Desk HQ", 84, "Nov 2"), ("The Economist", 94, "Nov 3"),
                       ("Silver Bulletin", 93.1, "Oct 8"), ("On Point Politics", 98, "Nov 1")],
              "seats": [("Decision Desk HQ", 241), ("The Economist", 235), ("Silver Bulletin", 238.7),
                        ("Sabato's Crystal Ball", 239), ("On Point Politics", 251)]},
    "senate": {"prob": [("Decision Desk HQ", 65, "Nov 2"), ("Silver Bulletin", 75, "Oct 19"),
                        ("On Point Politics", 88, "Nov 1")],
               "seats": [("Decision Desk HQ", 52), ("The Economist", 51), ("Silver Bulletin", 52.2),
                         ("On Point Politics", 54.8)]},
    "both": {"prob": [("Decision Desk HQ", 63, "Nov 2"), ("Silver Bulletin", 74.5, "Oct 8")]},
}
POLY_COMBO = "https://gamma-api.polymarket.com/events?slug=balance-of-power-2026-midterms"


def polymarket():
    """Democratic chances from Polymarket's balance-of-power market (House, Senate, both)."""
    j = get(POLY_COMBO)
    try:
        ms = j[0]["markets"]
    except (TypeError, IndexError, KeyError):
        return None
    px = {}
    for m in ms:
        try:
            px[m.get("groupItemTitle", "")] = round(float(json.loads(m["outcomePrices"])[0]) * 100, 1)
        except (KeyError, ValueError, TypeError, IndexError):
            continue
    dd, ds_rh, rs_dh = px.get("Democrats Sweep"), px.get("D Senate, R House"), px.get("R Senate, D House")
    if dd is None:
        return None
    return {"both": dd, "house": round(dd + (rs_dh or 0), 1), "senate": round(dd + (ds_rh or 0), 1), "raw": px}


def outlet_weight(now_dt):
    """Outlets count for half the composite until 7 PM ET, then fade to zero by 1 AM ET as real votes arrive."""
    start = ELECTION_DAY_UTC
    hrs = (now_dt - start).total_seconds() / 3600
    if hrs <= 0:
        return 0.5
    return round(max(0.0, 0.5 * (1 - hrs / 6)), 3)


def composite(control, poly, seats, now_dt):
    w = outlet_weight(now_dt)
    out = {"outletWeight": w, "marketWeight": round(1 - w, 3), "chambers": {}}

    def dem_price(ev):
        if not ev:
            return None, None
        d = next((m for m in ev["markets"] if (m["ticker"] or "").endswith("-D")), None)
        settled = next((m for m in ev["markets"] if m["result"] == "yes"), None)
        return (d["price"] if d else None), (party_of(settled) if settled else None)

    def combo_dd(ev):
        if not ev:
            return None
        m = next((m for m in ev["markets"] if (m["ticker"] or "").endswith("-DD") or "sweep" in (m["name"] or "").lower() and "dem" in (m["name"] or "").lower()), None)
        return m["price"] if m else None

    for ch in ("house", "senate", "both"):
        if ch == "both":
            k, settled = combo_dd(control.get("combo")), None
        else:
            k, settled = dem_price(control.get(ch))
        pm = poly.get(ch) if poly else None
        markets = [x for x in (("Kalshi", k), ("Polymarket", pm)) if x[1] is not None]
        outlets = OUTLETS[ch]["prob"]
        m_avg = sum(v for _, v in markets) / len(markets) if markets else None
        o_avg = sum(v for _, v, _ in outlets) / len(outlets)
        if settled:
            value = 100.0 if settled == "D" else 0.0
        elif m_avg is None:
            value = o_avg
        else:
            value = w * o_avg + (1 - w) * m_avg
        entry = {"value": round(value, 1), "marketAvg": None if m_avg is None else round(m_avg, 1),
                 "outletAvg": round(o_avg, 1), "settled": settled,
                 "sources": [{"name": n, "value": v, "type": "market", "asOf": "live"} for n, v in markets] +
                            [{"name": n, "value": v, "type": "outlet", "asOf": d} for n, v, d in outlets]}
        if ch != "both":
            o_seats = OUTLETS[ch]["seats"]
            os_avg = sum(v for _, v in o_seats) / len(o_seats)
            live = seats[ch].get("expD_market") or seats[ch].get("expD_races")
            entry["seats"] = round(w * os_avg + (1 - w) * live, 1) if live is not None else round(os_avg, 1)
            entry["seatSources"] = [{"name": "Kalshi seat market", "value": live, "type": "market"}] + \
                                   [{"name": n, "value": v, "type": "outlet"} for n, v in o_seats]
        out["chambers"][ch] = entry
    return out


# ---------- House races ----------
HOUSE_SERIES = "https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXHOUSERACE&limit=200&with_nested_markets=true"


def slim_event(ev):
    return {"ticker": ev.get("event_ticker"),
            "markets": [{k: v for k, v in market_view(m).items() if k in ("ticker", "name", "price", "result")}
                        for m in (ev.get("markets") or [])]}


def house_events():
    out, cursor = {}, ""
    for _ in range(5):
        j = get(HOUSE_SERIES + (f"&cursor={cursor}" if cursor else ""))
        if not j:
            break
        for ev in j.get("events") or []:
            m = re.match(r"KXHOUSERACE-([A-Z]{2})(\d{2}|AL)-", ev.get("event_ticker", ""))
            if m:
                out[m.group(1) + m.group(2)] = slim_event(ev)
        cursor = j.get("cursor")
        if not cursor or not j.get("events"):
            break
    # Older single-district series (e.g. HOUSETX15-26) for districts not in the KXHOUSERACE series. Discovery is cached.
    cache = os.path.join(OUT_DIR, "house_legacy.json")
    try:
        legacy = json.load(open(cache))
        fresh = (time.time() - os.path.getmtime(cache)) < 3600
    except (OSError, ValueError):
        legacy, fresh = {}, False
    if not fresh:
        try:
            reps = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "house_reps.json")))["reps"]
        except (OSError, ValueError, KeyError):
            reps = {}
        legacy = {}
        missing = [d for d in reps if d not in out]
        with ThreadPoolExecutor(max_workers=4) as ex:
            def probe(d):
                num = d[2:]
                tk = f"HOUSE{d[:2]}{'AL' if num == 'AL' else int(num)}-26"
                j = get(API.format(tk), tries=1)
                return d, (tk if j and j.get("event") else None)
            for d, tk in ex.map(probe, missing):
                if tk:
                    legacy[d] = tk
        json.dump(legacy, open(cache, "w"))
    for d, tk in legacy.items():
        if d in out:
            continue
        j = get(API.format(tk))
        if j and j.get("event"):
            ev = j["event"]
            ev.setdefault("markets", j.get("markets") or [])
            out[d] = slim_event(ev)
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat(timespec="seconds")

    jobs = {f"c:{k}": v for k, v in CONTROL_EVENTS.items()}
    jobs.update({f"s:{k}": v for k, v in SEAT_EVENTS.items()})
    jobs.update({f"r:{st}": SPECIAL.get(st, f"SENATE{st}-26") for st in SENATE_STATES})
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {k: ex.submit(fetch_event, v) for k, v in jobs.items()}
        futs.update({f"g:{st}": ex.submit(fetch_series_event, f"GOVPARTY{st}") for st in GOV_STATES})
        f_head = ex.submit(headlines)
        f_truth = ex.submit(truth_posts)
        f_house = ex.submit(house_calls)
        f_poly = ex.submit(polymarket)
        f_hev = ex.submit(house_events)
        res = {k: f.result() for k, f in futs.items()}
        heads, truth, hcalls, poly = f_head.result(), f_truth.result(), f_house.result(), f_poly.result()
        house = f_hev.result()

    control = {k: res[f"c:{k}"] for k in CONTROL_EVENTS}
    senate = {st: res[f"r:{st}"] for st in SENATE_STATES}
    summaries = {st: race_summary(ev, polls_closed(st, now_dt)) for st, ev in senate.items()}
    governors = {st: res[f"g:{st}"] for st in GOV_STATES}
    gov_summary = {st: race_summary(ev, polls_closed(st, now_dt)) for st, ev in governors.items()}

    house_summary = {d: race_summary(ev, polls_closed(d[:2], now_dt)) for d, ev in house.items()}
    h_called = {"D": 0, "R": 0, "I": 0}
    for d, sm in house_summary.items():
        if sm and sm["winner"]:
            h_called[sm["winner"]] += 1
    # Fill in districts Kalshi doesn't cover with PollCheck (AP/DDHQ) calls when available.
    if hcalls:
        for c in hcalls.get("all", []):
            key = c["d"].replace("-", "")
            key = key[:2] + (key[2:].zfill(2) if key[2:].isdigit() else "AL")
            if key not in house_summary or not (house_summary[key] or {}).get("winner"):
                h_called[c["p"]] += 1

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
        "house": {"calledD": h_called["D"], "calledR": h_called["R"], "calledI": h_called["I"],
                  "kalshiDistricts": len(house), "counting": hcalls["counting"] if hcalls else None,
                  "racesTotal": 435, "sourceUpdated": hcalls["updated"] if hcalls else None,
                  "recent": hcalls["recent"] if hcalls else [],
                  "expD_market": expected_seats(res["s:house"])},
    }

    comp = composite(control, poly, seats, now_dt)
    data = {"updated": now, "control": control, "senate": senate, "raceSummary": summaries, "seats": seats,
            "polymarket": poly, "composite": comp,
            "governors": governors, "govSummary": gov_summary, "house": house, "houseSummary": house_summary,
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
           "house": {"p": dem(control.get("house")), "c": comp["chambers"]["house"]["value"],
                     "cs": comp["chambers"]["house"].get("seats"), "exp": seats["house"]["expD_market"],
                     "d": seats["house"]["calledD"], "r": seats["house"]["calledR"]},
           "senate": {"p": dem(control.get("senate")), "c": comp["chambers"]["senate"]["value"],
                      "cs": comp["chambers"]["senate"].get("seats"),
                      "exp": seats["senate"]["expD_market"] or seats["senate"]["expD_races"],
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

    print(f"{now}: govs={sum(1 for v in governors.values() if v)}/36 races={sum(1 for v in senate.values() if v)}/35 senateCalled={s_called} "
          f"house={'ok' if hcalls else 'none'} truth={truth['source']}:{len(truth['posts'])} heads={len(heads)}")


if __name__ == "__main__":
    main()
