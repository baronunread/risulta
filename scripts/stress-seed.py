#!/usr/bin/env python3
"""Seed a disposable local Risulta preview database with deterministic traffic."""

import argparse
import hashlib
import json
import os
import random
import sqlite3
import sys
import time
from pathlib import Path

DEFAULT_EVENTS = 250_000
MAX_EVENTS = 1_000_000
SEED = 20261006
BATCH_SIZE = 2_000
SITE_SPECS = [
    ("Atelier Étoile | Éditions & objets", "atelier-etoile.example"),
    ("Northstar Outdoor Supply Company", "northstar-outdoor-supply.example"),
    ("Café 東京と京都の旅日記", "tokyo-kyoto-journal.example"),
    ("München Fahrradmanufaktur", "munich-bicycle-works.example"),
    ("The Very Long Name for a Small Independent Bookshop and Reading Room", "long-name-bookshop.example"),
    ("Crème brûlée & co. / recettes", "creme-brulee-recipes.example"),
    ("Studio Δelta - design & research", "delta-design-research.example"),
    ("Coastal Houseplants and Garden Notes", "coastal-houseplants.example"),
]
PATHS = [
    "/", "/shop", "/shop/new-arrivals", "/collections/summer-edit", "/products/linen-shirt",
    "/products/café-crème-and-vanilla", "/journal", "/journal/how-to-choose-a-gift",
    "/guides/東京/週末の過ごし方", "/collections/été?sort=popular",
    "/blog/2026/slow-living-and-small-spaces", "/account/sign-in", "/checkout/success",
    "/search?q=handmade+ceramics", "/pages/our-story?utm_source=archive",
    "/catalog/家具/木製テーブル", "/events/spring-market",
    "/collections/" + "handcrafted-artisanal-limited-edition-" * 22 + "été-東京",
    "/journal/" + "independent-makers-and-sustainable-materials-" * 20 + "final-notes",
]
REFERRERS = [
    "", "https://www.google.com/", "https://www.google.com/search?q=independent+shop",
    "https://duckduckgo.com/?q=thoughtful+gifts", "https://www.instagram.com/atelier/",
    "https://www.pinterest.com/pin/123456789/", "https://news.example.org/weekly-edit",
    "https://newsletter.example.com/archive/42?utm_campaign=summer_launch",
    "https://t.co/a1b2c3", "https://www.reddit.com/r/BuyItForLife/",
]
CAMPAIGNS = ["", "spring_launch", "summer_edit", "welcome_series", "brand_search", "creator_collab_é", "holiday_2026"]
SOURCES = ["", "google", "instagram", "newsletter", "pinterest", "direct", "creator_東京", "partner"]
MEDIUMS = ["", "organic", "social", "email", "cpc", "referral"]
EVENTS = ["pageview", "pageview", "pageview", "pageview", "add_to_cart", "sign_up", "purchase", "newsletter_subscribe", "search"]
LONG_REFERRER = "https://newsletter.example.com/archive/" + "weekly-editorial-special-edition-" * 22 + "?utm_source=dispatch&utm_campaign=" + "summer_collection_story_" * 8
LONG_CAMPAIGN = "campaign_" + "independent_makers_sustainable_design_" * 12
LONG_EVENT = "product_interest_" + "limited_edition_handcrafted_collection_" * 10
GOAL_EVENT_NAMES = ["add_to_cart", "sign_up", "purchase", "newsletter_subscribe", "search"]
SCHEMA_TABLES = {"sites", "events", "goals", "funnels", "funnel_steps", "users", "sessions", "site_users", "site_salts"}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, help="Disposable local preview data directory")
    parser.add_argument("--events", type=int, default=DEFAULT_EVENTS, help=f"Number of events (default {DEFAULT_EVENTS}, maximum {MAX_EVENTS})")
    args = parser.parse_args()
    if not 1 <= args.events <= MAX_EVENTS:
        parser.error(f"--events must be between 1 and {MAX_EVENTS}")
    return args


def checked_paths(data_dir):
    given = Path(data_dir).expanduser()
    # Validate both the supplied path and its resolved location, so symlinks
    # cannot redirect writes into a real installation.
    if not given.is_absolute():
        raise ValueError("--data-dir must be an absolute path")
    resolved = given.resolve(strict=True)
    allowed_prefixes = ("/tmp/risulta-local-preview-", "/tmp/risulta-stress-", "/private/tmp/risulta-local-preview-", "/private/tmp/risulta-stress-")
    lexical = str(given).rstrip("/")
    actual = str(resolved)
    if not any(lexical.startswith(prefix) for prefix in allowed_prefixes) or not any(actual.startswith(prefix) for prefix in allowed_prefixes):
        raise ValueError("refusing data directory outside /tmp/risulta-local-preview-* or /tmp/risulta-stress-*")
    db_path = resolved / "d1" / "DB.sqlite"
    marker = resolved / ".stress-seed.json"
    if resolved not in db_path.resolve().parents:
        raise ValueError("database symlink points outside the disposable data directory")
    if not db_path.is_file():
        raise ValueError(f"initialized database not found: {db_path}")
    return db_path, marker


def require_initialized(db):
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    missing = SCHEMA_TABLES - tables
    if missing:
        raise ValueError("database schema is incomplete: " + ", ".join(sorted(missing)))
    cols = {row[1] for row in db.execute("PRAGMA table_info(events)")}
    expected = {"id", "site_id", "ts", "name", "path", "referrer", "visitor", "source", "medium", "campaign", "content", "term", "value"}
    if not expected <= cols:
        raise ValueError("events table does not match the Risulta store schema")
    for table, required in {
        "goals": {"id", "site_id", "name", "event_name", "path", "created_at"},
        "funnels": {"id", "site_id", "name", "created_at"},
        "funnel_steps": {"funnel_id", "position", "goal_id"},
    }.items():
        actual = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
        if not required <= actual:
            raise ValueError(f"{table} table does not match the current Risulta store schema")
    sites = db.execute("SELECT id, name, domain FROM sites ORDER BY id").fetchall()
    if not sites:
        raise ValueError("database has no initialized sites")
    return sites


def ensure_demo_data(db):
    now = int(time.time())
    for index, (name, domain) in enumerate(SITE_SPECS):
        public_key = f"stress-demo-{index + 1:02d}-20261006"
        db.execute("INSERT OR IGNORE INTO sites(name, domain, public_key, created_at) VALUES(?,?,?,?)", (name, domain, public_key, now))
    sites = db.execute("SELECT id, name, domain FROM sites ORDER BY id").fetchall()
    for site_id, _, _ in sites:
        have = db.execute("SELECT count(*) FROM goals WHERE site_id=?", (site_id,)).fetchone()[0]
        for index in range(have, 20):
            event_name = GOAL_EVENT_NAMES[index % len(GOAL_EVENT_NAMES)]
            name = f"Stress goal {index + 1:02d} - {event_name}"
            path = "/checkout/success" if event_name == "purchase" else (PATHS[index % len(PATHS)] if index % 3 else "")
            db.execute("INSERT OR IGNORE INTO goals(site_id,name,event_name,path,created_at) VALUES(?,?,?,?,?)", (site_id, name, event_name, path, now))
    # Keep funnels capped at two per site, with three ordered goal steps.
    for site_id, _, _ in sites:
        existing = db.execute("SELECT id FROM funnels WHERE site_id=? ORDER BY id LIMIT 2", (site_id,)).fetchall()
        while len(existing) < 2:
            title = "Browse to purchase" if len(existing) == 0 else "Discover and subscribe"
            db.execute("INSERT INTO funnels(site_id,name,created_at) VALUES(?,?,?)", (site_id, title, now))
            existing.append((db.execute("SELECT last_insert_rowid()").fetchone()[0],))
        goal_ids = {row[0]: row[1] for row in db.execute("SELECT id,event_name FROM goals WHERE site_id=? ORDER BY id", (site_id,))}
        by_event = {}
        for gid, event in goal_ids.items():
            by_event.setdefault(event, gid)
        for funnel_index, (funnel_id,) in enumerate(existing):
            selected = [by_event.get(x) for x in (("add_to_cart", "sign_up", "purchase") if funnel_index == 0 else ("search", "newsletter_subscribe", "purchase"))]
            for position, goal_id in enumerate(selected):
                if goal_id is not None:
                    db.execute("INSERT OR IGNORE INTO funnel_steps(funnel_id,position,goal_id) VALUES(?,?,?)", (funnel_id, position, goal_id))
    return sites


def event_rows(sites, count):
    rng = random.Random(SEED)
    now = int(time.time())
    today_start = (now // 86400) * 86400
    start = today_start - 89 * 86400
    # Existing sites share most of the volume; the eight additional sites
    # each receive a smaller slice so visitor totals stay plausible.
    weights = [4 if i < max(0, len(sites) - len(SITE_SPECS)) else 1 for i in range(len(sites))]
    cumulative = []
    total_weight = 0
    for weight in weights:
        total_weight += weight
        cumulative.append(total_weight)
    rows = []
    sequence = 0
    visitor_number = [0] * len(sites)
    while sequence < count:
        pick = rng.randrange(total_weight)
        site_index = next(i for i, bound in enumerate(cumulative) if pick < bound)
        site_id = sites[site_index][0]
        session_length = min(rng.randint(2, 6), count - sequence)
        visitor_no = visitor_number[site_index]
        visitor_number[site_index] += 1
        # Most sessions fall across the 90-day range, with frequent traffic
        # today so current dashboards and same-day journey filters are useful.
        day_offset = 89 if rng.random() < 0.18 else rng.randrange(89)
        day_start = start + day_offset * 86400
        if day_offset == 89:
            anchor = max(day_start, now - rng.randint(20 * 60, 5 * 3600))
        else:
            hour = rng.choice((8, 9, 10, 12, 13, 14, 18, 19, 20, 21))
            anchor = day_start + hour * 3600 + rng.randint(0, 23 * 60)
        day_key = time.strftime("%Y-%m-%d", time.gmtime(anchor))
        visitor = hashlib.sha256(f"risulta-stress-v1:{site_id}:{day_key}:{visitor_no // 2}".encode("utf-8")).hexdigest()[:24]
        # A session shares its acquisition attributes and follows a coherent
        # browse, consideration, conversion sequence with realistic gaps.
        source = "creator_" + "atelier_independent_editorial_" * 9 if rng.random() < 0.001 else rng.choice(SOURCES)
        medium = rng.choice(MEDIUMS)
        campaign = LONG_CAMPAIGN if rng.random() < 0.025 else rng.choice(CAMPAIGNS)
        referrer = LONG_REFERRER if rng.random() < 0.025 else rng.choice(REFERRERS)
        names = ["pageview", "pageview", "add_to_cart", "pageview", "sign_up", "purchase"]
        elapsed = 0
        for step in range(session_length):
            sequence += 1
            event_name = names[min(step, len(names) - 1)]
            path = "/checkout/success" if event_name == "purchase" else rng.choice(PATHS)
            elapsed += rng.randint(8, 420) if step else 0
            ts = min(anchor + elapsed, now)
            if ts // 86400 != anchor // 86400:
                ts = anchor
            # Long strings are intentionally rare but searchable across the
            # path, referrer, source, campaign, and event-name dimensions.
            if rng.random() < 0.012:
                path = rng.choice(PATHS[-2:])
            if rng.random() < 0.004:
                referrer = LONG_REFERRER
            row_event = LONG_EVENT if rng.random() < 0.001 else event_name
            value = round(rng.choice((12.5, 29.99, 64.0, 125.75, 899.0, 12500.0, 250000.0)), 2) if event_name == "purchase" else None
            rows.append((site_id, ts, row_event, path, referrer, visitor, source, medium, campaign,
                         rng.choice(("", "hero", "footer", "creator_東京")), rng.choice(("", "ceramics", "café", "design")), value))
            if len(rows) >= BATCH_SIZE:
                yield rows
                rows = []
    if rows:
        yield rows


def main():
    args = parse_args()
    try:
        db_path, marker_path = checked_paths(args.data_dir)
        if marker_path.exists():
            prior = json.loads(marker_path.read_text(encoding="utf-8"))
            raise ValueError(f"seed marker already exists ({prior.get('events', 'unknown')} events); refusing duplicate run")
        db = sqlite3.connect(str(db_path), timeout=30)
        db.execute("PRAGMA busy_timeout=30000")
        sites = require_initialized(db)
        marker = {"version": 1, "status": "running", "seed": SEED, "events": args.events,
                  "data_dir": str(Path(args.data_dir).resolve())}
        temp_marker = marker_path.with_name(marker_path.name + ".tmp")
        temp_marker.write_text(json.dumps(marker, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        os.replace(temp_marker, marker_path)
        db.execute("BEGIN IMMEDIATE")
        try:
            sites = ensure_demo_data(db)
            insert = "INSERT INTO events(site_id,ts,name,path,referrer,visitor,source,medium,campaign,content,term,value) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
            inserted = 0
            for batch in event_rows(sites, args.events):
                db.executemany(insert, batch)
                inserted += len(batch)
            db.commit()
        except BaseException:
            db.rollback()
            raise
        counts = db.execute("SELECT s.name,count(e.id) FROM sites s LEFT JOIN events e ON e.site_id=s.id GROUP BY s.id ORDER BY s.id").fetchall()
        db.close()
        marker = {"version": 1, "status": "complete", "seed": SEED, "events": inserted,
                  "data_dir": str(Path(args.data_dir).resolve()), "sites": len(sites)}
        temp_marker = marker_path.with_name(marker_path.name + ".tmp")
        temp_marker.write_text(json.dumps(marker, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        os.replace(temp_marker, marker_path)
        print(f"Inserted {inserted:,} deterministic events across {len(sites)} sites (last 90 days).")
        print("Per-site event aggregates:")
        for name, n in counts:
            print(f"  {name}: {n:,}")
    except (OSError, sqlite3.Error, ValueError, json.JSONDecodeError) as error:
        print(f"stress-seed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
