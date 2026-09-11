#!/bin/sh
# Seed a running Risulta Sprout with an admin login, two sites, goals and traffic.
# The server must have been started with RISULTA_ADMIN_EMAIL/PASSWORD set.
# Usage: BASE=http://127.0.0.1:8099 ADMIN_EMAIL=a@x.test ADMIN_PASSWORD=... sh seed.sh
set -eu
BASE="${BASE:-http://127.0.0.1:8099}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-change-me-immediately-1}"
JAR=$(mktemp /tmp/sprout-seed.XXXXXX)
trap 'rm -f "$JAR"' EXIT

curl -s -m 10 -X POST "$BASE/login" -H 'content-type: application/json' -c "$JAR" -b "$JAR" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" > /dev/null
CSRF=$(curl -s -m 10 -b "$JAR" "$BASE/api/session" | python3 -c 'import sys,json; print(json.load(sys.stdin)["csrf"])')

api() { curl -s -m 10 -X POST "$BASE$1" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" -b "$JAR" -d "$2"; echo; }

echo "--- sites ---"
SHOP_KEY=$(api /api/sites '{"name":"Shop","domain":"shop.example.com"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["publicKey"])')
BLOG_KEY=$(api /api/sites '{"name":"Blog","domain":"blog.example.com"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["publicKey"])')
echo "shop=$SHOP_KEY blog=$BLOG_KEY"

echo "--- goals ---"
api /api/sites/1/goals '{"name":"Signup","eventName":"signup"}'
api /api/sites/1/goals '{"name":"Checkout view","eventName":"pageview","path":"/checkout"}'

echo "--- traffic (distinct visitors via distinct User-Agents) ---"
event() { curl -s -m 10 -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/event/$1" -H 'content-type: text/plain' -A "$2" -d "$3"; }
event "$SHOP_KEY" "seed-shopper-1" '{"name":"pageview","path":"/?utm_source=newsletter&utm_medium=email&utm_campaign=launch","referrer":"https://search.example.org/q","domain":"shop.example.com"}'
event "$SHOP_KEY" "seed-shopper-1" '{"name":"pageview","path":"/pricing","domain":"shop.example.com"}'
event "$SHOP_KEY" "seed-shopper-1" '{"name":"signup","path":"/pricing","domain":"shop.example.com","value":1}'
event "$SHOP_KEY" "seed-shopper-2" '{"name":"pageview","path":"/checkout","domain":"shop.example.com"}'
event "$BLOG_KEY" "seed-reader-1" '{"name":"pageview","path":"/hello","domain":"blog.example.com"}'
echo "seeded"
