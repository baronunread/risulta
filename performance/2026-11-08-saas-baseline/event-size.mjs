// Bytes per stored event: 30,000 pageviews through the real binary, then `sqlite3 DATA_DIR/d1/DB.sqlite "select name, sum(pgsize) from dbstat group by name"`.
// Run: bun performance/2026-11-08-saas-baseline/event-size.mjs (build dist/risulta-sprout first)
import { spawn } from "node:child_process";
const dir = process.env.DATA_DIR || "/tmp/risulta-event-size";
const app = spawn(process.env.SPROUT_BENCH_BINARY || "./dist/risulta-sprout", [], { env: { ...process.env, PORT: "8197", SB_DATA_DIR: dir, SB_TRUSTED_PROXIES: "127.0.0.1", RISULTA_ADMIN_EMAIL: "a@b.co", RISULTA_ADMIN_PASSWORD: "benchmark-password-0001" }, stdio: "ignore" });
const base = "http://127.0.0.1:8197";
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/healthz")).status === 200) break; } catch { await new Promise(r => setTimeout(r, 50)); } }
const l = await fetch(base + "/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.co", password: "benchmark-password-0001" }) });
const cookie = l.headers.get("set-cookie").split(";")[0];
const csrf = (await (await fetch(base + "/api/session", { headers: { cookie } })).json()).csrf;
const site = await (await fetch(base + "/api/sites", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf, cookie }, body: JSON.stringify({ name: "S", domain: "s.example" }) })).json();
const N = 30000; let ip = 0;
const refs = ["https://news.ycombinator.com/", "https://www.google.com/", "", "https://t.co/x", ""];
for (let i = 0; i < N; i++) {
  const b = JSON.stringify({ name: "pageview", domain: "s.example", path: "/blog/post-" + (i % 300) + "-some-slug", referrer: refs[i % 5] });
  const r = await fetch(base + "/api/event/" + site.publicKey, { method: "POST", body: b, headers: { "user-agent": "Mozilla/5.0 test" + (i % 500), "x-forwarded-for": "198.18." + ((ip >> 8) & 255) + "." + (ip++ & 255) } });
  if (r.status !== 202) { console.log("status", r.status); break; }
}
app.kill("SIGTERM"); await new Promise(r => app.once("exit", r));
