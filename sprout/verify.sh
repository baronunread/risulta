#!/bin/sh
# Verify a running Risulta Sprout: auth, boundaries, isolation, attribution,
# goals, reports, ranges, metrics, backup and static assets. Fails non-zero
# on any mismatch.
# The server must have been started with the admin secrets below, built with
# sproutboat 0.10.3+. For EXPECT_TRUST=1 also set SB_TRUSTED_PROXIES=127.0.0.1
# (the loopback peer); for EXPECT_TRUST=0 leave it unset.
# The scrypt-migration check additionally needs SB_DATA_DIR pointing at the
# server's data directory; it is skipped when unset.
# Usage: BASE=... ADMIN_EMAIL=... ADMIN_PASSWORD=... EXPECT_TRUST=0 sh sprout/verify.sh
set -eu
BASE="${BASE:-http://127.0.0.1:8099}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-change-me-verify-0001}"
EXPECT_TRUST="${EXPECT_TRUST:-0}"
JAR_A=$(mktemp /tmp/sprout-verify-a.XXXXXX)
JAR_V=$(mktemp /tmp/sprout-verify-v.XXXXXX)
JAR_T=$(mktemp /tmp/sprout-verify-t.XXXXXX)
trap 'rm -f "$JAR_A" "$JAR_V" "$JAR_T"' EXIT
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "ok: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

expect_code() {
  desc="$1"; method="$2"; path="$3"; data="${4:-}"; want="$5"; ctype="${6:-application/json}"; jar="${7:-}"; csrf="${8:-}"
  if [ -n "$data" ]; then
    if [ -n "$csrf" ]; then
      got=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X "$method" "$BASE$path" -H "content-type: $ctype" -b "$jar" -H "x-csrf-token: $csrf" -d "$data")
    elif [ -n "$jar" ]; then
      got=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X "$method" "$BASE$path" -H "content-type: $ctype" -b "$jar" -d "$data")
    else
      got=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X "$method" "$BASE$path" -H "content-type: $ctype" -d "$data")
    fi
  else
    if [ -n "$jar" ]; then
      got=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X "$method" "$BASE$path" -b "$jar")
    else
      got=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X "$method" "$BASE$path")
    fi
  fi
  if [ "$got" = "$want" ]; then ok "$desc ($got)"; else bad "$desc (want $want, got $got)"; fi
}

expect_json() {
  desc="$1"; path="$2"; expr="$3"; want="$4"; jar="${5:-}"
  if [ -n "$jar" ]; then jarflag="-b $jar"; else jarflag=""; fi
  got=$(curl -s -m 10 $jarflag "$BASE$path" | python3 -c "import sys,json; print($expr)")
  if [ "$got" = "$want" ]; then ok "$desc ($got)"; else bad "$desc (want $want, got $got)"; fi
}

STAMP=$(date +%s)
SHOP="shop-$STAMP.example.com"
BLOG="blog-$STAMP.example.com"
FAKE="nobody-$STAMP@example.com"

# Anonymous: HTML goes to login (303 POST-redirect-GET, like the Bun app),
# API gets 401, collector stays public.
expect_code "anonymous home redirects" GET / "" 303
expect_code "anonymous stats 401" GET /api/sites/1/stats "" 401
expect_code "anonymous report 401" GET /api/sites/1/report "" 401
expect_code "anonymous site page redirects" GET /sites/1 "" 303
expect_code "wrong password 401" POST /login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"wrong-password-000\"}" 401
i=0; while [ $i -lt 5 ]; do
  curl -s -m 10 -o /dev/null -X POST "$BASE/login" -H 'content-type: application/json' -d "{\"email\":\"$FAKE\",\"password\":\"x\"}"
  i=$((i + 1))
done
expect_code "rate limit 429" POST /login "{\"email\":\"$FAKE\",\"password\":\"x\"}" 429
ORIGIN_CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/login" -H 'content-type: application/json' -H 'Origin: https://evil.example.com' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
if [ "$ORIGIN_CODE" = 403 ]; then ok "cross-origin login 403"; else bad "cross-origin login 403 ($ORIGIN_CODE)"; fi

# Admin login (timed: measures the standalone KDF cost).
START=$(python3 -c 'import time; print(int(time.time() * 1000))')
expect_code "admin login 200" POST /login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" 200 "application/json" "" ""
curl -s -m 10 -X POST "$BASE/login" -H 'content-type: application/json' -c "$JAR_A" -b "$JAR_A" -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" > /dev/null
END=$(python3 -c 'import time; print(int(time.time() * 1000))')
echo "info: admin login took $((END - START)) ms (KDF x2: one failed + one success)"
CSRF_A=$(curl -s -m 10 -b "$JAR_A" "$BASE/api/session" | python3 -c 'import sys,json; print(json.load(sys.stdin)["csrf"])')
expect_json "session role admin" /api/session 'json.load(sys.stdin)["role"]' "admin" "$JAR_A"

# Sites, goals, boundaries.
SHOP_RESP=$(curl -s -m 10 -X POST "$BASE/api/sites" -H 'content-type: application/json' -H "x-csrf-token: $CSRF_A" -b "$JAR_A" -d "{\"name\":\"Shop\",\"domain\":\"$SHOP\"}")
SHOP_ID=$(echo "$SHOP_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
SHOP_KEY=$(echo "$SHOP_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["publicKey"])')
BLOG_RESP=$(curl -s -m 10 -X POST "$BASE/api/sites" -H 'content-type: application/json' -H "x-csrf-token: $CSRF_A" -b "$JAR_A" -d "{\"name\":\"Blog\",\"domain\":\"$BLOG\"}")
BLOG_ID=$(echo "$BLOG_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
BLOG_KEY=$(echo "$BLOG_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["publicKey"])')
expect_code "duplicate domain" POST /api/sites "{\"name\":\"Dup\",\"domain\":\"$SHOP\"}" 409 "application/json" "$JAR_A" "$CSRF_A"
expect_code "invalid domain" POST /api/sites '{"name":"Bad","domain":"not a domain!!"}' 400 "application/json" "$JAR_A" "$CSRF_A"
expect_code "missing csrf" POST /api/sites '{"name":"Nope","domain":"nope.example.com"}' 403 "application/json" "$JAR_A"
expect_code "unknown tracker key" GET "/js/deadbeef.js" "" 404
expect_code "unknown event key" POST "/api/event/deadbeef" '{"name":"pageview","path":"/","domain":"x"}' 404
expect_code "wrong-domain event" POST "/api/event/$SHOP_KEY" '{"name":"pageview","path":"/","domain":"evil.example.com"}' 403
expect_code "bad event name" POST "/api/event/$SHOP_KEY" "{\"name\":\"BOGUS!\",\"path\":\"/\",\"domain\":\"$SHOP\"}" 400
expect_code "bad value" POST "/api/event/$SHOP_KEY" "{\"name\":\"signup\",\"path\":\"/\",\"domain\":\"$SHOP\",\"value\":-1}" 400
expect_code "non-JSON body" POST "/api/event/$SHOP_KEY" 'not json' 400 "text/plain"
expect_code "unknown site stats" GET /api/sites/999999/stats "" 401 "application/json" ""
curl -s -m 10 -b "$JAR_A" -o /dev/null -w '%{http_code}\n' "$BASE/api/sites/999999/stats" | grep -q 404 && ok "unknown site stats authed (404)" || bad "unknown site stats authed"

# Traffic: server-derived visitor hashes. Same UA twice = one visitor;
# X-Forwarded-For is ignored unless the server trusts proxies.
event() { curl -s -m 10 -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/event/$1" -H 'content-type: text/plain' ${2:+-A "$2"} ${3:+-H "$3"} -d "$4"; }
event "$SHOP_KEY" "verify-ua-1" "" "{\"name\":\"pageview\",\"path\":\"/?utm_source=newsletter&utm_medium=email&utm_campaign=launch&junk=drop\",\"referrer\":\"https://search.example.org/q\",\"domain\":\"$SHOP\"}"
event "$SHOP_KEY" "verify-ua-1" "X-Forwarded-For: 203.0.113.9" "{\"name\":\"pageview\",\"path\":\"/pricing\",\"domain\":\"$SHOP\"}"
event "$SHOP_KEY" "verify-ua-2" "" "{\"name\":\"pageview\",\"path\":\"/checkout\",\"domain\":\"$SHOP\"}"
event "$SHOP_KEY" "verify-ua-2" "" "{\"name\":\"signup\",\"path\":\"/pricing\",\"domain\":\"$SHOP\",\"value\":3}"
event "$BLOG_KEY" "verify-ua-9" "" "{\"name\":\"pageview\",\"path\":\"/hello\",\"domain\":\"$BLOG\"}"
curl -s -m 10 -X POST "$BASE/api/sites/$SHOP_ID/goals" -H 'content-type: application/json' -H "x-csrf-token: $CSRF_A" -b "$JAR_A" -d '{"name":"Signup","eventName":"signup"}' > /dev/null
expect_code "duplicate goal" POST "/api/sites/$SHOP_ID/goals" '{"name":"Signup","eventName":"signup"}' 409 "application/json" "$JAR_A" "$CSRF_A"
expect_code "bad goal event" POST "/api/sites/$SHOP_ID/goals" '{"name":"Bad","eventName":"NOPE!"}' 400 "application/json" "$JAR_A" "$CSRF_A"

if [ "$EXPECT_TRUST" = "1" ]; then WANT_VISITORS=3; else WANT_VISITORS=2; fi
expect_json "shop pageviews" "/api/sites/$SHOP_ID/stats?period=1" 'json.load(sys.stdin)["summary"]["pageviews"]' 3 "$JAR_A"
expect_json "shop visitors (XFF trust=$EXPECT_TRUST)" "/api/sites/$SHOP_ID/stats?period=1" 'json.load(sys.stdin)["summary"]["visitors"]' "$WANT_VISITORS" "$JAR_A"
expect_json "blog isolated" "/api/sites/$BLOG_ID/stats?period=1" 'json.load(sys.stdin)["summary"]["pageviews"]' 1 "$JAR_A"
expect_json "blog path label" "/api/sites/$BLOG_ID/stats?period=1" 'json.load(sys.stdin)["paths"][0]["label"]' "/hello" "$JAR_A"
expect_json "attribution recorded" "/api/sites/$SHOP_ID/stats?period=1" '"newsletter" in [r["label"] for r in json.load(sys.stdin)["referrers"]]' "True" "$JAR_A"
expect_json "junk param dropped" "/api/sites/$SHOP_ID/stats?period=1" 'json.load(sys.stdin)["paths"][0]["label"]' "/" "$JAR_A"
expect_json "goal conversion" "/api/sites/$SHOP_ID/stats?period=1" 'json.load(sys.stdin)["goals"][0]["conversions"]' 1 "$JAR_A"
expect_json "goal value sum" "/api/sites/$SHOP_ID/stats?period=1" 'json.load(sys.stdin)["goals"][0]["value"]' 3 "$JAR_A"
curl -s -m 10 -X POST "$BASE/api/sites/$SHOP_ID/goals" -H 'content-type: application/json' -H "x-csrf-token: $CSRF_A" -b "$JAR_A" -d '{"name":"Checkout view","eventName":"pageview","path":"/checkout"}' > /dev/null
GOAL_IDS=$(curl -s -m 10 -b "$JAR_A" "$BASE/api/sites/$SHOP_ID/goals" | python3 -c 'import sys,json; print(" ".join(str(g["id"]) for g in json.load(sys.stdin)[:2]))')
G1=$(echo "$GOAL_IDS" | python3 -c 'import sys; print(sys.stdin.read().split()[0])')
G2=$(echo "$GOAL_IDS" | python3 -c 'import sys; print(sys.stdin.read().split()[1])')
curl -s -m 10 -X POST "$BASE/api/sites/$SHOP_ID/funnels" -H 'content-type: application/json' -H "x-csrf-token: $CSRF_A" -b "$JAR_A" -d "{\"name\":\"Purchase\",\"goalIds\":[$G1,$G2]}" > /dev/null
expect_code "funnel needs name" POST "/api/sites/$SHOP_ID/funnels" "{\"name\":\"\",\"goalIds\":[$G1,$G2]}" 400 "application/json" "$JAR_A" "$CSRF_A"
expect_code "funnel needs two goals" POST "/api/sites/$SHOP_ID/funnels" "{\"name\":\"Short\",\"goalIds\":[$G1]}" 400 "application/json" "$JAR_A" "$CSRF_A"
expect_code "funnel rejects foreign goal" POST "/api/sites/$SHOP_ID/funnels" "{\"name\":\"Nope\",\"goalIds\":[$G1,999999]}" 400 "application/json" "$JAR_A" "$CSRF_A"
expect_json "funnel step conversions" "/api/sites/$SHOP_ID/stats?period=1" 'json.load(sys.stdin)["funnels"][0]["steps"][0]["conversions"]' 1 "$JAR_A"
CMP=$(curl -s -m 10 -b "$JAR_A" "$BASE/sites/$SHOP_ID?compare=1")
case "$CMP" in
  *"Previous period"*) ok "comparison mode" ;;
  *) bad "comparison mode" ;;
esac
REP_PAGE=$(curl -s -m 10 -b "$JAR_A" "$BASE/sites/$SHOP_ID/reports?dimension=path")
case "$REP_PAGE" in
  *"Full report"*data-table*) ok "html report page" ;;
  *) bad "html report page" ;;
esac
expect_code "anonymous reports redirects" GET "/sites/$SHOP_ID/reports" "" 303
expect_code "report unknown site" GET /sites/999999/reports "" 404 "application/json" "$JAR_A"
SET_PAGE=$(curl -s -m 10 -b "$JAR_A" "$BASE/sites/$SHOP_ID/settings")
case "$SET_PAGE" in
  *"Website settings"*Funnels*) ok "settings page" ;;
  *) bad "settings page" ;;
esac
expect_json "explicit range works" "/api/sites/$SHOP_ID/stats?from=2026-01-01&to=2026-12-31" 'json.load(sys.stdin)["summary"]["pageviews"]' 3 "$JAR_A"
expect_code "reversed range" GET "/api/sites/$SHOP_ID/stats?from=2026-12-31&to=2026-01-01" "" 400 "application/json" "$JAR_A"
expect_json "report total" "/api/sites/$SHOP_ID/report?dimension=path" 'json.load(sys.stdin)["total"]' 3 "$JAR_A"
FRAG=$(curl -s -m 10 -b "$JAR_A" "$BASE/sites/$SHOP_ID/partials/live?period=1")
case "$FRAG" in
  *'class="metrics"'*'Top pages'*) ok "live fragment (authed)" ;;
  *) bad "live fragment (authed)" ;;
esac
expect_code "live fragment anonymous" GET "/sites/$SHOP_ID/partials/live?period=1" "" 303
expect_code "live fragment unknown site" GET /sites/999999/partials/live?period=1 "" 404 "application/json" "$JAR_A"
CSV=$(curl -s -m 10 -b "$JAR_A" "$BASE/api/sites/$SHOP_ID/report?dimension=path&format=csv")
case "$CSV" in
  "label,pageviews,visitors,value"*) ok "csv header" ;;
  *) bad "csv header ($CSV)" ;;
esac

# Operational counters: 5 accepted events (4 shop + 1 blog), 4 rejected
# (wrong domain, bad name, bad value, non-JSON body). Unknown keys 404 and
# are not counted, mirroring the Bun app.
METRICS=$(curl -s -m 10 "$BASE/metrics")
METRICS_TYPE=$(curl -s -m 10 -o /dev/null -w '%{content_type}' "$BASE/metrics")
case "$METRICS_TYPE" in
  *text/plain*) ok "metrics content type ($METRICS_TYPE)" ;;
  *) bad "metrics content type ($METRICS_TYPE)" ;;
esac
metric_is() { echo "$METRICS" | python3 -c "import sys; rows=dict(l.split() for l in sys.stdin.read().splitlines() if l.strip()); sys.exit(0 if rows.get('$1') == '$2' else 1)"; }
if metric_is events_accepted_total 5; then ok "metrics accepted (5)"; else bad "metrics accepted ($(echo "$METRICS" | grep events_accepted_total))"; fi
if metric_is events_rejected_total 4; then ok "metrics rejected (4)"; else bad "metrics rejected ($(echo "$METRICS" | grep events_rejected_total))"; fi
# NOTE: x-sb-cpu-ms is not asserted: the runtime stamps it only on
# synchronously returned responses, and this router always returns a
# promise (async crypto). Observed additionally that the tag does not
# fire even for sync string-body handlers on 0.10.2.

# Viewer isolation.
VIEWER="viewer-$STAMP@example.com"
curl -s -m 10 -X POST "$BASE/api/users" -H 'content-type: application/json' -H "x-csrf-token: $CSRF_A" -b "$JAR_A" \
  -d "{\"email\":\"$VIEWER\",\"password\":\"viewer-password-0001\",\"role\":\"viewer\",\"siteIds\":[$SHOP_ID]}" > /dev/null
curl -s -m 10 -X POST "$BASE/login" -H 'content-type: application/json' -c "$JAR_V" -b "$JAR_V" -d "{\"email\":\"$VIEWER\",\"password\":\"viewer-password-0001\"}" > /dev/null
CSRF_V=$(curl -s -m 10 -b "$JAR_V" "$BASE/api/session" | python3 -c 'import sys,json; print(json.load(sys.stdin)["csrf"])')
expect_json "viewer sees shop" "/api/sites/$SHOP_ID/stats?period=1" 'json.load(sys.stdin)["summary"]["pageviews"]' 3 "$JAR_V"
expect_code "viewer blocked from blog" GET "/api/sites/$BLOG_ID/stats?period=1" "" 404 "application/json" "$JAR_V"
expect_code "viewer cannot create sites" POST /api/sites '{"name":"X","domain":"x-$STAMP.example.com"}' 403 "application/json" "$JAR_V" "$CSRF_V"
expect_code "viewer cannot create users" POST /api/users '{"email":"z@example.com","password":"viewer-password-0001"}' 403 "application/json" "$JAR_V" "$CSRF_V"

# Profile edit and self-deletion on a throwaway account (admin untouched).
TEMP2="profile-$STAMP@example.com"
curl -s -m 10 -X POST "$BASE/api/users" -H 'content-type: application/json' -H "x-csrf-token: $CSRF_A" -b "$JAR_A" \
  -d "{\"email\":\"$TEMP2\",\"password\":\"temp2-password-0001\",\"role\":\"viewer\",\"siteIds\":[]}" > /dev/null
curl -s -m 10 -X POST "$BASE/login" -H 'content-type: application/json' -c "$JAR_T" -b "$JAR_T" -d "{\"email\":\"$TEMP2\",\"password\":\"temp2-password-0001\"}" > /dev/null
CSRF_T=$(curl -s -m 10 -b "$JAR_T" "$BASE/api/session" | python3 -c 'import sys,json; print(json.load(sys.stdin)["csrf"])')
expect_code "profile update" POST /api/account/profile "{\"displayName\":\"Renamed\",\"email\":\"$TEMP2\"}" 200 "application/json" "$JAR_T" "$CSRF_T"
expect_json "profile reflected" /api/session 'json.load(sys.stdin)["displayName"]' "Renamed" "$JAR_T"
expect_code "profile duplicate email" POST /api/account/profile "{\"displayName\":\"Renamed\",\"email\":\"$ADMIN_EMAIL\"}" 409 "application/json" "$JAR_T" "$CSRF_T"
expect_code "delete needs confirmation" POST /api/account/delete '{"confirmation":"nope"}' 400 "application/json" "$JAR_T" "$CSRF_T"
expect_code "delete own account" POST /api/account/delete '{"confirmation":"DELETE"}' 200 "application/json" "$JAR_T" "$CSRF_T"
expect_code "deleted profile cannot login" POST /login "{\"email\":\"$TEMP2\",\"password\":\"temp2-password-0001\"}" 401
rm -f "$JAR_T"

# User deletion (and its guards).
TEMP="temp-$STAMP@example.com"
TEMP_ID=$(curl -s -m 10 -X POST "$BASE/api/users" -H 'content-type: application/json' -H "x-csrf-token: $CSRF_A" -b "$JAR_A" \
  -d "{\"email\":\"$TEMP\",\"password\":\"temp-password-0001\",\"role\":\"viewer\",\"siteIds\":[]}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
expect_code "delete user" POST "/api/users/$TEMP_ID/delete" '{}' 200 "application/json" "$JAR_A" "$CSRF_A"
expect_code "deleted user cannot login" POST /login "{\"email\":\"$TEMP\",\"password\":\"temp-password-0001\"}" 401
ADMIN_ID=$(curl -s -m 10 -b "$JAR_A" "$BASE/api/session" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
expect_code "cannot delete self" POST "/api/users/$ADMIN_ID/delete" '{}' 400 "application/json" "$JAR_A" "$CSRF_A"

# Password change round-trip (restores the original at the end).
NEW_PW="rotated-password-$STAMP-01"
curl -s -m 10 -X POST "$BASE/api/account/password" -H 'content-type: application/json' -H "x-csrf-token: $CSRF_A" -b "$JAR_A" \
  -d "{\"current\":\"$ADMIN_PASSWORD\",\"password\":\"$NEW_PW\"}" > /dev/null
expect_code "old password dead" POST /login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" 401
JAR_B=$(mktemp /tmp/sprout-verify-b.XXXXXX)
curl -s -m 10 -X POST "$BASE/login" -H 'content-type: application/json' -c "$JAR_B" -b "$JAR_B" -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$NEW_PW\"}" > /dev/null
CSRF_B=$(curl -s -m 10 -b "$JAR_B" "$BASE/api/session" | python3 -c 'import sys,json; print(json.load(sys.stdin)["csrf"])')
expect_json "login with new password" /api/session 'json.load(sys.stdin)["email"]' "$ADMIN_EMAIL" "$JAR_B"
curl -s -m 10 -X POST "$BASE/api/account/password" -H 'content-type: application/json' -H "x-csrf-token: $CSRF_B" -b "$JAR_B" \
  -d "{\"current\":\"$NEW_PW\",\"password\":\"$ADMIN_PASSWORD\"}" > /dev/null
rm -f "$JAR_B"
expect_code "password restored" POST /login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" 200

# Fresh session for the final checks (rotation revoked the old jar).
curl -s -m 10 -X POST "$BASE/login" -H 'content-type: application/json' -c "$JAR_A" -b "$JAR_A" -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" > /dev/null
CSRF_A=$(curl -s -m 10 -b "$JAR_A" "$BASE/api/session" | python3 -c 'import sys,json; print(json.load(sys.stdin)["csrf"])')

# Online backup (admin only): integrity-checked snapshot, no downtime.
BACKUP_RESP=$(curl -s -m 10 -X POST "$BASE/api/backup" -H 'content-type: application/json' -H "x-csrf-token: $CSRF_A" -b "$JAR_A" -d '{}')
echo "$BACKUP_RESP" | python3 -c 'import sys,json; d=json.load(sys.stdin); m=d.get("manifest", {}); t=m.get("tables", {}); assert d.get("ok") is True and d.get("bytes", 0) > 0 and d.get("path") and t.get("sites", 0) >= 2 and t.get("events", 0) >= 5, "bad backup response"' \
  && ok "online backup with manifest" || bad "online backup ($BACKUP_RESP)"
expect_code "backup needs csrf" POST /api/backup '{}' 403 "application/json" "$JAR_A"
expect_code "viewer cannot backup" POST /api/backup '{}' 403 "application/json" "$JAR_V" "$CSRF_V"

# Ingest throttle: 240 events per 60 s window per IP (INGEST binding), so
# 300 rapid posts from one client must trip at least one 429. A throwaway
# site keeps the earlier pageview assertions intact.
FLOOD_RESP=$(curl -s -m 10 -X POST "$BASE/api/sites" -H 'content-type: application/json' -H "x-csrf-token: $CSRF_A" -b "$JAR_A" -d "{\"name\":\"Flood\",\"domain\":\"flood-$STAMP.example.com\"}")
FLOOD_KEY=$(echo "$FLOOD_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["publicKey"])')
HIT429=0
i=0; while [ $i -lt 300 ]; do
  code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/api/event/$FLOOD_KEY" -H 'content-type: text/plain' -A "flood-ua" -d "{\"name\":\"pageview\",\"path\":\"/f\",\"domain\":\"flood-$STAMP.example.com\"}")
  if [ "$code" = 429 ]; then HIT429=1; fi
  i=$((i + 1))
done
if [ "$HIT429" = 1 ]; then ok "ingest rate limit 429"; else bad "ingest rate limit 429 (never tripped)"; fi

# Bun-hash migration: a scrypt$ row (Bun format) logs in via the runtime's
# verify-only scrypt and is re-hashed to the current KDF. Needs SB_DATA_DIR
# pointing at the server's data directory; skipped when unset.
if [ -n "${SB_DATA_DIR:-}" ]; then
  SCRYPT_EMAIL="migrated-$STAMP@example.com"
  SCRYPT_PW="migrated-password-0001"
  SCRYPT_ROW=$(SCRYPT_PW="$SCRYPT_PW" bun -e "import { hashPassword } from './lib/auth.js'; console.log(hashPassword(process.env.SCRYPT_PW))")
  export SCRYPT_EMAIL SCRYPT_PW SCRYPT_ROW
  SB_DATA_DIR="${SB_DATA_DIR%/}" python3 -c 'import os,sqlite3,time; e=os.environ; db=sqlite3.connect(e["SB_DATA_DIR"]+"/d1/DB.sqlite", timeout=10); db.execute("INSERT INTO users (email, password_hash, role, display_name, created_at) VALUES (?, ?, ?, ?, ?)", (e["SCRYPT_EMAIL"], e["SCRYPT_ROW"], "viewer", "migrated", int(time.time()))); db.commit(); db.close()' \
    && ok "scrypt fixture inserted" || bad "scrypt fixture inserted"
  SCRYPT_FMT=$(SB_DATA_DIR="${SB_DATA_DIR%/}" python3 -c 'import os,sqlite3; e=os.environ; db=sqlite3.connect(e["SB_DATA_DIR"]+"/d1/DB.sqlite", timeout=10); print(db.execute("SELECT password_hash FROM users WHERE email = ?", (e["SCRYPT_EMAIL"],)).fetchone()[0].split("$")[0])')
  if [ "$SCRYPT_FMT" = scrypt ]; then ok "scrypt fixture format"; else bad "scrypt fixture format ($SCRYPT_FMT)"; fi
  expect_code "scrypt login 200" POST /login "{\"email\":\"$SCRYPT_EMAIL\",\"password\":\"$SCRYPT_PW\"}" 200
  SCRYPT_FMT2=$(SB_DATA_DIR="${SB_DATA_DIR%/}" python3 -c 'import os,sqlite3; e=os.environ; db=sqlite3.connect(e["SB_DATA_DIR"]+"/d1/DB.sqlite", timeout=10); print(db.execute("SELECT password_hash FROM users WHERE email = ?", (e["SCRYPT_EMAIL"],)).fetchone()[0].split("$")[0])')
  if [ "$SCRYPT_FMT2" = h1 ]; then ok "scrypt rehashed to h1"; else bad "scrypt rehashed to h1 ($SCRYPT_FMT2)"; fi
else
  echo "skip: scrypt migration check (SB_DATA_DIR unset)"
fi

# Logout kills the session; public assets never needed auth.
DASH=$(curl -s -m 10 -b "$JAR_A" "$BASE/sites/$SHOP_ID" | python3 -c 'import sys; print("live-stats" in sys.stdin.read())')
if [ "$DASH" = True ]; then ok "site dashboard page"; else bad "site dashboard page"; fi
expect_code "logout" POST /logout '{}' 200 "application/json" "$JAR_A" "$CSRF_A"
expect_code "session dead after logout" GET /api/session "" 401 "application/json" "$JAR_A"
STATIC_JS=$(curl -s -m 10 -o /dev/null -w '%{http_code} %{content_type}' "$BASE/dashboard.js")
case "$STATIC_JS" in
  "200"*javascript*) ok "static dashboard.js ($STATIC_JS)" ;;
  *) bad "static dashboard.js ($STATIC_JS)" ;;
esac
STATIC_CSS=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/style.css")
if [ "$STATIC_CSS" = 200 ]; then ok "static style.css"; else bad "static style.css ($STATIC_CSS)"; fi
STATIC_ICON=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/favicon-light.svg")
if [ "$STATIC_ICON" = 200 ]; then ok "static favicon"; else bad "static favicon ($STATIC_ICON)"; fi
STATIC_MANIFEST=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/site.webmanifest")
if [ "$STATIC_MANIFEST" = 200 ]; then ok "static webmanifest"; else bad "static webmanifest ($STATIC_MANIFEST)"; fi
AVATAR=$(curl -s -m 10 "$BASE/avatar.svg?name=Verify")
case "$AVATAR" in
  "<svg"*"viewBox"*) ok "avatar renders" ;;
  *) bad "avatar renders" ;;
esac
AVATAR_TYPE=$(curl -s -m 10 -o /dev/null -w '%{content_type}' "$BASE/avatar.svg?name=Verify")
case "$AVATAR_TYPE" in
  *svg*) ok "avatar content type ($AVATAR_TYPE)" ;;
  *) bad "avatar content type ($AVATAR_TYPE)" ;;
esac

echo "---"
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
