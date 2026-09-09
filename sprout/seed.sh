#!/bin/sh
# Seed a running Risulta Sprout probe with two sites, goals and traffic.
# Usage: BASE=http://127.0.0.1:8099 sh sprout/seed.sh
set -eu
BASE="${BASE:-http://127.0.0.1:8099}"

post() { curl -s -m 10 -X POST "$BASE$1" -H 'content-type: application/json' -d "$2"; echo; }

echo "--- sites ---"
SHOP_KEY=$(post /api/sites '{"name":"Shop","domain":"shop.example.com"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["publicKey"])')
BLOG_KEY=$(post /api/sites '{"name":"Blog","domain":"blog.example.com"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["publicKey"])')
echo "shop=$SHOP_KEY blog=$BLOG_KEY"

echo "--- goals ---"
post /api/sites/1/goals '{"name":"Signup","eventName":"signup"}'
post /api/sites/1/goals '{"name":"Checkout view","eventName":"pageview","path":"/checkout"}'

echo "--- traffic ---"
event() { curl -s -m 10 -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/event/$1" -H 'content-type: text/plain' -d "$2"; }
event "$SHOP_KEY" '{"name":"pageview","path":"/?utm_source=newsletter&utm_medium=email&utm_campaign=launch","referrer":"https://search.example.org/q","domain":"shop.example.com","visitor":"shop-1"}'
event "$SHOP_KEY" '{"name":"pageview","path":"/pricing","domain":"shop.example.com","visitor":"shop-1"}'
event "$SHOP_KEY" '{"name":"signup","path":"/pricing","domain":"shop.example.com","visitor":"shop-1","value":1}'
event "$SHOP_KEY" '{"name":"pageview","path":"/checkout","domain":"shop.example.com","visitor":"shop-2"}'
event "$BLOG_KEY" '{"name":"pageview","path":"/hello","domain":"blog.example.com","visitor":"blog-1"}'
echo "seeded: shop=$SHOP_KEY blog=$BLOG_KEY"
