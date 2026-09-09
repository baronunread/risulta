#!/bin/sh
# Verify a running Risulta Sprout probe: boundaries, isolation, attribution,
# goals, reports, ranges and static assets. Fails non-zero on any mismatch.
# Usage: BASE=http://127.0.0.1:8099 sh sprout/verify.sh
set -eu
BASE="${BASE:-http://127.0.0.1:8099}"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "ok: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

expect_code() {
  desc="$1"; method="$2"; path="$3"; data="${4:-}"; want="$5"; ctype="${6:-application/json}"
  if [ -n "$data" ]; then
    got=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X "$method" "$BASE$path" -H "content-type: $ctype" -d "$data")
  else
    got=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X "$method" "$BASE$path")
  fi
  if [ "$got" = "$want" ]; then ok "$desc ($got)"; else bad "$desc (want $want, got $got)"; fi
}

expect_json() {
  desc="$1"; path="$2"; expr="$3"; want="$4"
  got=$(curl -s -m 10 "$BASE$path" | python3 -c "import sys,json; print($expr)")
  if [ "$got" = "$want" ]; then ok "$desc ($got)"; else bad "$desc (want $want, got $got)"; fi
}

# Fresh isolated state per run: unique domains.
STAMP=$(date +%s)
SHOP="shop-$STAMP.example.com"
BLOG="blog-$STAMP.example.com"

SHOP_RESP=$(curl -s -m 10 -X POST "$BASE/api/sites" -H 'content-type: application/json' -d "{\"name\":\"Shop\",\"domain\":\"$SHOP\"}")
SHOP_ID=$(echo "$SHOP_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
SHOP_KEY=$(echo "$SHOP_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["publicKey"])')
BLOG_RESP=$(curl -s -m 10 -X POST "$BASE/api/sites" -H 'content-type: application/json' -d "{\"name\":\"Blog\",\"domain\":\"$BLOG\"}")
BLOG_ID=$(echo "$BLOG_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
BLOG_KEY=$(echo "$BLOG_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["publicKey"])')

expect_code "duplicate domain" POST /api/sites "{\"name\":\"Dup\",\"domain\":\"$SHOP\"}" 409
expect_code "invalid domain" POST /api/sites '{"name":"Bad","domain":"not a domain!!"}' 400
expect_code "unknown tracker key" GET "/js/deadbeef.js" "" 404
expect_code "unknown event key" POST "/api/event/deadbeef" '{"name":"pageview","path":"/","domain":"x"}' 404
expect_code "wrong-domain event" POST "/api/event/$SHOP_KEY" '{"name":"pageview","path":"/","domain":"evil.example.com"}' 403
expect_code "bad event name" POST "/api/event/$SHOP_KEY" "{\"name\":\"BOGUS!\",\"path\":\"/\",\"domain\":\"$SHOP\"}" 400
expect_code "bad value" POST "/api/event/$SHOP_KEY" "{\"name\":\"signup\",\"path\":\"/\",\"domain\":\"$SHOP\",\"value\":-1}" 400
expect_code "non-JSON body" POST "/api/event/$SHOP_KEY" 'not json' 400 "text/plain"
expect_code "unknown site stats" GET /api/sites/999999/stats "" 404

curl -s -m 10 -X POST "$BASE/api/event/$SHOP_KEY" -H 'content-type: text/plain' \
  -d "{\"name\":\"pageview\",\"path\":\"/?utm_source=newsletter&utm_medium=email&utm_campaign=launch&junk=drop\",\"referrer\":\"https://search.example.org/q\",\"domain\":\"$SHOP\",\"visitor\":\"s-1\"}" > /dev/null
curl -s -m 10 -X POST "$BASE/api/event/$SHOP_KEY" -H 'content-type: text/plain' \
  -d "{\"name\":\"signup\",\"path\":\"/pricing\",\"domain\":\"$SHOP\",\"visitor\":\"s-1\",\"value\":3}" > /dev/null
curl -s -m 10 -X POST "$BASE/api/event/$BLOG_KEY" -H 'content-type: text/plain' \
  -d "{\"name\":\"pageview\",\"path\":\"/hello\",\"domain\":\"$BLOG\",\"visitor\":\"b-1\"}" > /dev/null
curl -s -m 10 -X POST "$BASE/api/sites/$SHOP_ID/goals" -H 'content-type: application/json' \
  -d '{"name":"Signup","eventName":"signup"}' > /dev/null
expect_code "duplicate goal" POST "/api/sites/$SHOP_ID/goals" '{"name":"Signup","eventName":"signup"}' 409
expect_code "bad goal event" POST "/api/sites/$SHOP_ID/goals" '{"name":"Bad","eventName":"NOPE!"}' 400

expect_json "shop pageviews" "/api/sites/$SHOP_ID/stats?period=1" 'json.load(sys.stdin)["summary"]["pageviews"]' 1
expect_json "shop isolated from blog" "/api/sites/$BLOG_ID/stats?period=1" 'json.load(sys.stdin)["summary"]["pageviews"]' 1
expect_json "blog path label" "/api/sites/$BLOG_ID/stats?period=1" 'json.load(sys.stdin)["paths"][0]["label"]' "/hello"
expect_json "attribution source" "/api/sites/$SHOP_ID/stats?period=1" 'json.load(sys.stdin)["sources"][0]["label"]' "newsletter"
expect_json "junk param dropped" "/api/sites/$SHOP_ID/stats?period=1" 'json.load(sys.stdin)["paths"][0]["label"]' "/"
expect_json "goal conversion" "/api/sites/$SHOP_ID/stats?period=1" 'json.load(sys.stdin)["goals"][0]["conversions"]' 1
expect_json "goal value sum" "/api/sites/$SHOP_ID/stats?period=1" 'json.load(sys.stdin)["goals"][0]["value"]' 3
expect_json "explicit range works" "/api/sites/$SHOP_ID/stats?from=2026-01-01&to=2026-12-31" 'json.load(sys.stdin)["summary"]["pageviews"]' 1
expect_code "reversed range" GET "/api/sites/$SHOP_ID/stats?from=2026-12-31&to=2026-01-01" "" 400
expect_json "report total" "/api/sites/$SHOP_ID/report?dimension=path" 'json.load(sys.stdin)["total"]' 1
CSV=$(curl -s -m 10 "$BASE/api/sites/$SHOP_ID/report?dimension=path&format=csv")
case "$CSV" in
  "label,pageviews,visitors,value"*) ok "csv header" ;;
  *) bad "csv header ($CSV)" ;;
esac
STATIC_JS=$(curl -s -m 10 -o /dev/null -w '%{http_code} %{content_type}' "$BASE/dashboard.js")
case "$STATIC_JS" in
  "200"*javascript*) ok "static dashboard.js ($STATIC_JS)" ;;
  *) bad "static dashboard.js ($STATIC_JS)" ;;
esac
STATIC_CSS=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/style.css")
if [ "$STATIC_CSS" = 200 ]; then ok "static style.css"; else bad "static style.css ($STATIC_CSS)"; fi
DASH=$(curl -s -m 10 "$BASE/sites/$SHOP_ID" | python3 -c 'import sys; print("live-stats" in sys.stdin.read())')
if [ "$DASH" = True ]; then ok "site dashboard page"; else bad "site dashboard page"; fi

echo "---"
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
